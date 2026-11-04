import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { t } from "./runtime.js";

// The fifth engine: Hermes Agent (Nous Research). Every Hermes *profile* is one employee: its own model, provider, memory,
// skills, tools and SOUL stay in Hermes, exactly as Hermes Desktop and Telegram use them; the office only talks to it.
// Like Codex and Gemini, one process per turn, the conversation resumed by session id:
//   hermes -p <profile> chat --query-file <file> --format stream-json --source tool [--resume <id>] [--yolo]
// stream-json (hermes_cli/stream_json.py) prints one JSON object per line on stdout:
//   {"type":"system","subtype":"init","session_id"}  {"type":"text","text"}  {"type":"tool_use","name","input"}
//   {"type":"tool_result","name","output","is_error"}  {"type":"result","session_id","exit_code","text","tokens":{…},"error"}
// Nothing in the Hermes install or the profiles is written or changed from here; profiles are only read for their names.
// Kept in its own file (plus a few hooks in providers.ts / employee.ts / index.ts) so upstream updates merge cleanly.

export const HERMES_PREFIX = "hermes:";
export const isHermesModel = (model?: string) => !!model && model.startsWith(HERMES_PREFIX);
export const hermesProfileOf = (model: string) => model.slice(HERMES_PREFIX.length);
const PROFILE_ID = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,100}$/;

// ---- where Hermes lives ----
const expand = (p: string) => path.resolve(p.replace(/^~(?=$|[\\/])/, os.homedir()).replace(/%([^%]+)%/g, (_, v) => process.env[v] ?? ""));

/** Hermes' data folder, as Hermes itself picks it: $HERMES_HOME, else %LOCALAPPDATA%\hermes on Windows, ~/.hermes elsewhere. */
export function hermesHome(): string {
  const env = process.env.HERMES_HOME?.trim();
  if (env) {
    // a HERMES_HOME that points at one profile (…/profiles/<name>) means the root above it
    const p = expand(env);
    return path.basename(path.dirname(p)) === "profiles" ? path.dirname(path.dirname(p)) : p;
  }
  if (process.platform === "win32") return path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local"), "hermes");
  return path.join(os.homedir(), ".hermes");
}

/** The hermes command: $HERMES_BIN, else the installer's venv, else `hermes` on PATH. */
export function hermesBin(): string {
  const env = process.env.HERMES_BIN?.trim();
  if (env) return expand(env);
  const home = hermesHome();
  const candidates = process.platform === "win32"
    ? [path.join(home, "hermes-agent", "venv", "Scripts", "hermes.exe")]
    : [path.join(home, "hermes-agent", "venv", "bin", "hermes"), path.join(os.homedir(), ".local", "bin", "hermes")];
  return candidates.find((c) => fs.existsSync(c)) ?? "hermes";
}

// ---- profiles ----
export interface HermesProfile { id: string; title: string; description: string; model: string; provider: string }

// profile.yaml / config.yaml are read for a handful of plain keys only. A tiny reader for "key: value" mappings by
// indentation is enough for those (no YAML library in the office); anything it cannot read is simply left empty.
function readYamlMap(file: string): Record<string, unknown> {
  let text = "";
  try { text = fs.readFileSync(file, "utf8").replace(/^﻿/, ""); } catch { return {}; }
  const root: Record<string, unknown> = {};
  const stack: Array<{ indent: number; obj: Record<string, unknown> }> = [{ indent: -1, obj: root }];
  for (const raw of text.split(/\r?\n/)) {
    if (!raw.trim() || raw.trim().startsWith("#") || raw.trim().startsWith("- ")) continue;
    const m = raw.match(/^(\s*)([^:#]+?):(?:\s+(.*))?$/);
    if (!m) continue;
    const indent = m[1].length, key = m[2].trim().replace(/^["']|["']$/g, "");
    while (stack.length > 1 && indent <= stack[stack.length - 1].indent) stack.pop();
    const parent = stack[stack.length - 1].obj;
    const value = (m[3] ?? "").replace(/\s+#.*$/, "").trim();
    if (!value) { const child: Record<string, unknown> = {}; parent[key] = child; stack.push({ indent, obj: child }); }
    else parent[key] = value.replace(/^["']|["']$/g, "");
  }
  return root;
}
const str = (v: unknown) => (typeof v === "string" ? v : "");

function readProfile(id: string, dir: string): HermesProfile {
  const meta = readYamlMap(path.join(dir, "profile.yaml"));
  const ui = (meta.ui_meta ?? {}) as Record<string, unknown>;
  const bot = (ui["hermes-bots"] ?? {}) as Record<string, unknown>;
  const cfg = readYamlMap(path.join(dir, "config.yaml"));
  const m = cfg.model;
  const model = typeof m === "string" ? m : str((m as Record<string, unknown> | undefined)?.default);
  const provider = typeof m === "object" && m ? str((m as Record<string, unknown>).provider) : str(cfg.provider);
  return { id, title: str(bot.title) || str(meta.display_name) || id, description: str(meta.description), model, provider };
}

let profileCache: { at: number; list: HermesProfile[] } | null = null;
/** "default" (the Hermes home itself) and every folder under <home>/profiles. Cached for a minute. */
export function hermesProfiles(fresh = false): HermesProfile[] {
  if (profileCache && !fresh && Date.now() - profileCache.at < 60e3) return profileCache.list;
  const home = hermesHome();
  const list: HermesProfile[] = [];
  if (fs.existsSync(path.join(home, "config.yaml"))) list.push(readProfile("default", home));
  try {
    for (const name of fs.readdirSync(path.join(home, "profiles")).sort()) {
      const dir = path.join(home, "profiles", name);
      if (PROFILE_ID.test(name) && !name.startsWith(".") && fs.statSync(dir).isDirectory()) list.push(readProfile(name, dir));
    }
  } catch {}
  profileCache = { at: Date.now(), list };
  return list;
}

/** The models the office offers for Hermes: one per profile ("hermes:<profile>"). */
export function hermesModels(): Array<{ id: string; name: string; desc: string; provider: "hermes" }> {
  return hermesProfiles().map((p) => ({ id: HERMES_PREFIX + p.id, name: `Hermes · ${p.title}`, desc: [p.id, p.model].filter(Boolean).join(" · "), provider: "hermes" as const }));
}

// ---- status (Settings → Models) ----
const runHermes = (args: string[], timeout: number) => new Promise<{ ok: boolean; out: string }>((resolve) => {
  execFile(hermesBin(), args, { timeout, encoding: "utf8", windowsHide: true, env: hermesEnv() }, (err, stdout, stderr) => resolve({ ok: !err, out: `${stdout ?? ""}${stderr ?? ""}`.trim() }));
});
export async function probeHermes(): Promise<{ connected: boolean; installed: boolean; version: string; detail: string }> {
  // the first start of Hermes' Python can take a while on Windows
  const v = await runHermes(["--version"], 45000);
  if (!v.ok) return { connected: false, installed: false, version: "", detail: "missing" };
  const version = (v.out.split("\n").find((l) => /\d+\.\d+/.test(l)) ?? "").replace(/^.*?(\d+\.\d+[\w.+-]*).*$/, "$1");
  const n = hermesProfiles(true).length;
  if (!n) return { connected: false, installed: true, version, detail: "noProfiles" };
  // every Hermes conversation runs through its gateway: when it is down (and Hermes cannot start it), no agent answers
  const g = await runHermes(["gateway", "status"], 30000);
  const down = /no gateway process detected|gateway is not running|not running/i.test(g.out);
  return { connected: true, installed: true, version, detail: down ? "gatewayDown" : `profiles:${n}` };
}

// Hermes errors people meet, said in their language with what to do; the original stays in brackets.
const KNOWN_ERRORS: Array<[RegExp, string]> = [
  [/gateway_elevated|started as administrator/i, "elevated"],
  [/gateway (inaccessible|absent|unavailable|draining)|service_identity_unverified|no gateway process|profile_parked|service_(failed|start_failed|disabled|masked|account_mismatch)/i, "gateway"],
  [/exhausted|cooldown|insufficient_quota|usage limit|quota exceeded/i, "exhausted"],
  [/\b401\b|unauthori[sz]ed|refresh token|invalid[_ ]api[_ ]key|sign in again|log ?in again|credentials? (expired|invalid)/i, "auth"],
  [/\b429\b|rate.?limit|too many requests/i, "rate"],
];
export function explainHermesError(raw: string): string {
  for (const [re, key] of KNOWN_ERRORS) if (re.test(raw)) return `${t(`server.hermes.err.${key}`)} (${raw.replace(/\s+/g, " ").slice(0, 120)})`;
  return raw;
}

// What a Hermes process inherits: the office's own environment, minus anything that would pin it to another task or profile
// (the profile comes from -p), plus UTF-8 output so Arabic arrives intact on Windows.
function hermesEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, PYTHONIOENCODING: "utf-8", PYTHONUTF8: "1", NO_COLOR: "1" };
  for (const k of Object.keys(env)) if (k.startsWith("HERMES_KANBAN_") || ["HERMES_PROFILE", "HERMES_SESSION_SOURCE", "TERMINAL_CWD"].includes(k)) delete env[k];
  return env;
}

// ---- one turn ----
export interface HermesTurn {
  cwd: string;
  profile: string;
  prompt: string;
  session?: string;      // resume this conversation
  yolo?: boolean;        // the employee may run anything without asking (the office's "bypass" permission)
  image?: string;        // one picture on disk (Hermes takes one per query)
  promptFile: string;    // where the prompt is written for --query-file (no length or quoting limits)
}
export interface HermesHandlers {
  onSession(id: string): void;
  onText(chunk: string): void;
  onTool(name: string, input: Record<string, unknown> | undefined): void;
  onToolError(name: string, output: string): void;
}
export interface HermesResult { ok: boolean; error?: string; inputTokens: number; outputTokens: number; cachedTokens: number; notFound?: boolean }

const RESUME_FAILED = /session\b.*\b(not found|does not exist|unknown|no such)|could not (find|resume) session|no session (with|named)/i;

export function runHermesTurn(turn: HermesTurn, h: HermesHandlers): { done: Promise<HermesResult>; kill: () => void } {
  fs.mkdirSync(path.dirname(turn.promptFile), { recursive: true });
  fs.writeFileSync(turn.promptFile, turn.prompt, { encoding: "utf8", mode: 0o600 });
  const args = ["-p", turn.profile, "chat", "--query-file", turn.promptFile, "--format", "stream-json", "--source", "tool"];
  if (turn.session) args.push("--resume", turn.session, "--no-restore-cwd");
  if (turn.yolo) args.push("--yolo");
  if (turn.image) args.push("--image", turn.image);

  let child: ChildProcess | undefined;
  let killed = false;
  const done = new Promise<HermesResult>((resolve) => {
    const res: HermesResult = { ok: false, inputTokens: 0, outputTokens: 0, cachedTokens: 0 };
    let buf = "", err = "", streamed = "", gotResult = false, session = turn.session ?? "";
    const setSession = (id: unknown) => { if (typeof id === "string" && id && id !== session) { session = id; h.onSession(id); } };
    try { child = spawn(hermesBin(), args, { cwd: turn.cwd, stdio: ["ignore", "pipe", "pipe"], env: hermesEnv(), windowsHide: true }); }
    catch (e) { resolve({ ...res, error: (e as Error).message }); return; }
    child.on("error", (e) => resolve({ ...res, error: (e as NodeJS.ErrnoException).code === "ENOENT" ? "hermes is not installed (or set HERMES_BIN)" : e.message }));
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (d: string) => {
      err = (err + d).slice(-6000);
      const m = d.match(/session_id:\s*(\S+)/); // the same line -Q prints; a fallback when init carried no id yet
      if (m) setSession(m[1]);
    });
    child.stdout?.on("data", (d: string) => {
      buf += d;
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line.startsWith("{")) continue; // bootstrap notices before the protocol starts
        let ev: Record<string, unknown>;
        try { ev = JSON.parse(line); } catch { continue; }
        if (ev.type === "system" && ev.subtype === "init") setSession(ev.session_id);
        else if (ev.type === "text" && typeof ev.text === "string") { streamed += ev.text; h.onText(ev.text); }
        else if (ev.type === "tool_use") h.onTool(String(ev.name ?? "tool"), ev.input && typeof ev.input === "object" ? ev.input as Record<string, unknown> : undefined);
        else if (ev.type === "tool_result" && ev.is_error) h.onToolError(String(ev.name ?? "tool"), String(ev.output ?? "").slice(0, 300));
        else if (ev.type === "result") {
          gotResult = true;
          setSession(ev.session_id);
          // replay_gap: the text events stopped part way; the result carries the whole reply. A reply that never streamed is sent whole.
          const text = typeof ev.text === "string" ? ev.text : "";
          if (text && (ev.replay_gap || !streamed.trim())) h.onText(ev.replay_gap && text.startsWith(streamed) ? text.slice(streamed.length) : text);
          const tk = (ev.tokens ?? {}) as Record<string, number>;
          res.inputTokens = Number(tk.input) || 0;
          res.outputTokens = Number(tk.output) || 0;
          res.cachedTokens = Number(tk.cache_read) || 0;
          res.ok = Number(ev.exit_code) === 0 && !ev.error;
          if (!res.ok) res.error = String(ev.error ?? "") || lastError(err) || `hermes exited with ${ev.exit_code}`;
        }
      }
    });
    child.on("close", (code) => {
      try { fs.unlinkSync(turn.promptFile); } catch {}
      if (killed) return resolve({ ...res, ok: false, error: "interrupted" });
      if (!gotResult) { res.ok = false; res.error = lastError(err) || `hermes exited with ${code}`; }
      if (!res.ok && turn.session && (RESUME_FAILED.test(res.error ?? "") || RESUME_FAILED.test(err))) res.notFound = true;
      if (!res.ok && res.error && !res.notFound) res.error = explainHermesError(res.error);
      resolve(res);
    });
  });
  return { done, kill: () => { killed = true; killTree(child); } };
}

// hermes.exe on Windows is a launcher with Python under it: the whole tree has to go, not just the launcher.
function killTree(child?: ChildProcess) {
  if (!child?.pid) return;
  if (process.platform === "win32") { try { execFile("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true }, () => {}); } catch {} }
  else { try { child.kill("SIGTERM"); } catch {} }
}

// stderr carries notices before the error: the last line that says what went wrong, without a Python traceback.
function lastError(stderr: string): string {
  const lines = stderr.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !/^(File "|Traceback|\^+$|session_id:)/.test(l));
  const hit = [...lines].reverse().find((l) => /error|failed|not found|denied|invalid/i.test(l)) ?? lines.pop() ?? "";
  return hit.slice(0, 400);
}

// ---- import (Settings → Models → Hermes) ----
export interface HermesOrg { name?: string; titles?: Record<string, string>; offices?: Array<{ id?: string; name?: string; agents?: string[]; theme?: string }> }

/** An org file in the shape the Hermes Office Bridge keeps (org.json: titles + offices), if there is one. */
export function readHermesOrg(file?: string): HermesOrg | null {
  if (!file) return null;
  try {
    const o = JSON.parse(fs.readFileSync(expand(file), "utf8").replace(/^﻿/, "")) as HermesOrg;
    return o && typeof o === "object" ? o : null;
  } catch { return null; }
}

/** Where an org file is likely to be: a hermes-office-bridge folder next to the office's own folder. */
export function guessHermesOrgFile(pkgRoot: string): string | undefined {
  const f = path.join(path.dirname(pkgRoot), "hermes-office-bridge", "org.json");
  return fs.existsSync(f) ? f : undefined;
}

export interface ImportPlan { offices: Array<{ id: string; name: string; theme?: string; agents: string[] }>; titles: Record<string, string> }

/** Which office each profile goes to. With an org file: its offices, in its order (a profile listed in several offices sits
 *  at its desk in the first and is shared with the others). Without one: everything in one office. Unknown profiles are
 *  skipped; profiles the org does not mention go to the last office, so nobody is lost. */
export function planHermesImport(org: HermesOrg | null, fallbackOffice: string): ImportPlan {
  const profiles = hermesProfiles(true);
  const known = new Set(profiles.map((p) => p.id));
  const titles: Record<string, string> = {};
  for (const p of profiles) titles[p.id] = (org?.titles?.[p.id] || p.title || p.id).slice(0, 40);
  const offices: ImportPlan["offices"] = [];
  for (const o of org?.offices ?? []) {
    const agents = (o.agents ?? []).filter((a) => known.has(a));
    if (!agents.length) continue;
    offices.push({ id: String(o.id ?? ""), name: String(o.name ?? o.id ?? "").slice(0, 60), theme: o.theme, agents });
  }
  const placed = new Set(offices.flatMap((o) => o.agents));
  const rest = profiles.map((p) => p.id).filter((id) => !placed.has(id));
  if (rest.length) offices.push({ id: "hermes-agents", name: fallbackOffice, agents: rest });
  return { offices, titles };
}

// Hermes' own tool names, shown in the office activity log the way the other engines' tools are ("Reading …", "Running …").
export function hermesToolAs(name: string, input: Record<string, unknown> = {}): { name: string; input: Record<string, unknown> } {
  const s = (v: unknown) => (typeof v === "string" ? v : Array.isArray(v) ? v.join(", ") : "");
  const map: Record<string, [string, Record<string, unknown>]> = {
    terminal: ["Bash", { command: s(input.command) }], execute_code: ["Bash", { command: s(input.code).split("\n")[0] }],
    read_file: ["Read", { file_path: s(input.path ?? input.file_path) }], write_file: ["Write", { file_path: s(input.path ?? input.file_path) }],
    patch: ["Edit", { file_path: s(input.path ?? input.file_path) }], search_files: ["Grep", { pattern: s(input.pattern ?? input.query) }],
    web_search: ["WebSearch", { query: s(input.query) }], web_extract: ["WebFetch", { url: s(input.urls ?? input.url) }],
    delegate_task: ["Agent", { description: s(input.goal ?? input.task ?? input.description) }],
  };
  const hit = map[name];
  return hit ? { name: hit[0], input: hit[1] } : { name, input };
}

// ---- office tools for Hermes ("link") ----
// Hermes reads its MCP servers from each profile's config.yaml. Linking adds one entry there, written by Hermes' own config code
// (scripts/hermes-link.py, the same save path `hermes mcp add` uses), with a backup of config.yaml and .env first:
//   mcp_servers.office = { url: http://127.0.0.1:<port>/mcp-hermes/<profile>, headers: { Authorization: Bearer ${MCP_OFFICE_API_KEY} } }
// The key itself goes to the profile's .env, as Hermes keeps every MCP secret. Tools then arrive as mcp__office__<tool>, the
// same names Claude employees use. The address and key never change (they come from a secret kept in the office's data
// folder), so the entry keeps working across restarts; when the office is not running Hermes just reports the server as down.
export const HERMES_MCP_NAME = "office";

/** Hermes' source folder (it holds hermes_bootstrap.py): $HERMES_REPO, else <home>/hermes-agent. */
export function hermesRepo(): string {
  const env = process.env.HERMES_REPO?.trim();
  return env ? expand(env) : path.join(hermesHome(), "hermes-agent");
}
/** The Python of Hermes' own venv, next to the hermes command; `python` as a last resort. */
export function hermesPython(): string {
  const bin = hermesBin();
  const dir = path.dirname(bin);
  const cands = process.platform === "win32" ? [path.join(dir, "python.exe"), path.join(hermesRepo(), "venv", "Scripts", "python.exe")] : [path.join(dir, "python3"), path.join(dir, "python"), path.join(hermesRepo(), "venv", "bin", "python3")];
  return cands.find((c) => path.isAbsolute(c) && fs.existsSync(c)) ?? (process.platform === "win32" ? "python" : "python3");
}
export const profileDir = (profile: string) => (profile === "default" ? hermesHome() : path.join(hermesHome(), "profiles", profile));

const linkedCache = new Map<string, { at: number; on: boolean }>();
/** Whether this profile's config.yaml has the office tools entry (cached for half a minute). */
export function hermesLinked(profile: string): boolean {
  const c = linkedCache.get(profile);
  if (c && Date.now() - c.at < 30e3) return c.on;
  const cfg = readYamlMap(path.join(profileDir(profile), "config.yaml"));
  const office = ((cfg.mcp_servers ?? {}) as Record<string, unknown>)[HERMES_MCP_NAME] as Record<string, unknown> | undefined;
  const on = !!office && str(office.url).includes("/mcp-hermes/") && !/^(false|no|off|0)$/i.test(str(office.enabled));
  linkedCache.set(profile, { at: Date.now(), on });
  return on;
}

/** Adds (or removes) the office entry in one profile, through Hermes' own Python. */
export function linkHermesProfile(profile: string, req: { action: "link" | "unlink"; url?: string; token?: string }, script: string): Promise<{ ok: boolean; error?: string }> {
  linkedCache.delete(profile);
  return new Promise((resolve) => {
    const env = { ...hermesEnv(), HERMES_HOME: profileDir(profile) };
    let child: ChildProcess;
    try { child = spawn(hermesPython(), [script, hermesRepo()], { stdio: ["pipe", "pipe", "pipe"], env, windowsHide: true }); }
    catch (e) { resolve({ ok: false, error: (e as Error).message }); return; }
    let out = "", err = "";
    const timer = setTimeout(() => { killTree(child); resolve({ ok: false, error: "timeout" }); }, 120000);
    child.stdout?.setEncoding("utf8"); child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (d: string) => { out += d; });
    child.stderr?.on("data", (d: string) => { err = (err + d).slice(-4000); });
    child.on("error", (e) => { clearTimeout(timer); resolve({ ok: false, error: e.message }); });
    child.on("close", () => {
      clearTimeout(timer);
      linkedCache.delete(profile);
      const line = out.trim().split(/\r?\n/).reverse().find((l) => l.startsWith("{"));
      try { const r = JSON.parse(line ?? "") as { ok?: boolean; error?: string }; resolve({ ok: !!r.ok, error: r.error }); }
      catch { resolve({ ok: false, error: lastError(err) || "no answer from hermes-link.py" }); }
    });
    child.stdin?.end(JSON.stringify({ ...req, name: HERMES_MCP_NAME }));
  });
}

// Which employee is running a Hermes turn for a profile right now: the office tools a profile calls act as that employee
// (a profile can sit in several offices). Outside a turn (Telegram, Hermes Desktop) they act as its first employee.
const activeTurns = new Map<string, unknown[]>();
export function hermesTurnStarted(profile: string, who: unknown) { const l = activeTurns.get(profile) ?? []; l.push(who); activeTurns.set(profile, l); }
export function hermesTurnEnded(profile: string, who: unknown) { const l = (activeTurns.get(profile) ?? []).filter((x) => x !== who); if (l.length) activeTurns.set(profile, l); else activeTurns.delete(profile); }
export const hermesActiveFor = (profile: string): unknown => activeTurns.get(profile)?.at(-1);
