import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { z } from "zod";
import { tool } from "@anthropic-ai/claude-agent-sdk";
import type { Express } from "express";
import type { Employee } from "./employee.js";
import { addOfficeTools } from "./office-tools.js";
import { t } from "./runtime.js";
import { writeFileAtomicSync } from "./fsutil.js";

// Group chats ("الغروبات"), like a messaging app: the boss and employees from any office in one conversation.
//  - The boss writes: the members named with @ answer; nobody named → the group's lead answers; @الكل / @all → everyone.
//  - An employee's answer is posted under their name; an @ in it asks that colleague in turn.
//  - Employees can also write on their own with the office tool post_to_group (e.g. from Telegram through Hermes).
//  - So that agents cannot talk in circles: after MAX_CHAIN answers in a row without the boss the group pauses and waits.
// A turn runs like a meeting turn (Employee.sendGroup): the prompt and the answer stay out of the employee's own chat.
// Kept in its own files (this one, web/groups.js, web/groups.css) with a few hooks elsewhere, so upstream updates merge cleanly.

export interface GroupMember { office: string; emp: string }
export interface GroupMessage { id: number; ts: number; from: string; name: string; text: string; color?: string }
export interface GroupDoc { id: string; name: string; members: GroupMember[]; lead?: string; created: number; nextId: number; chain: number; paused?: boolean; messages: GroupMessage[] }

const MAX_CHAIN = 8;      // answers in a row between employees before the group waits for the boss
const KEEP = 1000;        // messages kept per group
const HISTORY_LINES = 25; // what an employee is shown of the conversation (each answer runs in a fresh short session)
const AGENT_MENTIONS = 3; // colleagues one employee message can ask at once (@all is the boss's alone)

const memberKey = (m: GroupMember) => `${m.office}/${m.emp}`;
// names as lookup keys, ignoring case, diacritics, tatweel, alef/yaa/taa-marbuta spellings and _ / spaces
const nameKey = (s: string) => s.normalize("NFKC").toLowerCase().replace(/[ً-ٰٟـ]/g, "")
  .replace(/[أإآٱ]/g, "ا").replace(/ى/g, "ي").replace(/ة/g, "ه").replace(/[\s_-]+/g, " ").trim();
const ALL = ["الكل", "الجميع", "all", "everyone", "herkes"].map(nameKey);
// an answer that only thanks or agrees adds nothing to a conversation between employees
const COURTESY = /^(شكرا|شكرًا|شكراً|مشكور|تمام|اتفق|أتفق|متفق|موافق|حسنا|حسنًا|حسناً|ممتاز|رائع|جميل|تم|ok|okay|thanks|thank you|agreed|noted|great|sounds good|👍|🙏)/i;
const isCourtesy = (s: string) => s.length <= 60 && !/[?؟@]/.test(s) && COURTESY.test(s.trim());

export interface GroupsDeps {
  employee(office: string, emp: string): Employee | undefined;
  officeName(office: string): string;
  everyone(): Array<{ office: string; officeName: string; employees: Employee[] }>;
  broadcast(payload: unknown): void;
  dataDir: string;
}

export class Groups {
  private docs = new Map<string, GroupDoc>();
  private locks = new WeakMap<Employee, Promise<void>>(); // one group answer at a time per employee; members answer in parallel
  private typing = new Map<string, Set<string>>();    // group → member keys composing an answer right now
  private failures = new Map<string, { timer: NodeJS.Timeout; byError: Map<string, string[]> }>(); // group → error → who; said once
  private epochs = new Map<string, number>();          // bumped when a group pauses: answers employees asked for before it are dropped
  private dir: string;

  constructor(private d: GroupsDeps) {
    this.dir = path.join(d.dataDir, "groups");
    fs.mkdirSync(this.dir, { recursive: true });
    for (const f of fs.readdirSync(this.dir).filter((x) => x.endsWith(".json"))) {
      try { const g = JSON.parse(fs.readFileSync(path.join(this.dir, f), "utf8")) as GroupDoc; if (g?.id) { g.chain ??= 0; g.messages ??= []; this.docs.set(g.id, g); } } catch {}
    }
  }

  private save(g: GroupDoc) { writeFileAtomicSync(path.join(this.dir, `${g.id}.json`), JSON.stringify(g)); }
  private resolve(m: GroupMember) { return this.d.employee(m.office, m.emp); }
  /** The member a given employee is in this group (a Hermes profile shared by several offices counts as the same member). */
  memberOf(g: GroupDoc, e: Employee): GroupMember | undefined {
    return g.members.find((m) => m.office === e.cfg.officeId && m.emp === e.cfg.id)
      ?? (e.cfg.model?.startsWith("hermes:") ? g.members.find((m) => this.resolve(m)?.cfg.model === e.cfg.model) : undefined);
  }
  list() { return [...this.docs.values()].sort((a, b) => (b.messages.at(-1)?.ts ?? b.created) - (a.messages.at(-1)?.ts ?? a.created)); }
  get(id: string) { return this.docs.get(id); }
  find(nameOrId: string) { const k = nameKey(nameOrId); return this.docs.get(nameOrId) ?? [...this.docs.values()].find((g) => nameKey(g.name) === k); }

  summary(g: GroupDoc) {
    const last = g.messages.at(-1);
    return {
      id: g.id, name: g.name, lead: g.lead, paused: !!g.paused, created: g.created, count: g.messages.length,
      last: last ? { name: last.name, text: last.text.slice(0, 120), ts: last.ts } : null,
      members: g.members.map((m) => { const e = this.resolve(m); return { ...m, key: memberKey(m), name: e?.cfg.name ?? m.emp, role: e?.cfg.role ?? "", color: e?.cfg.color, officeName: this.d.officeName(m.office), gone: !e }; }),
      typing: [...(this.typing.get(g.id) ?? [])].map((k) => { const [office, emp] = k.split("/"); return this.d.employee(office, emp)?.cfg.name ?? emp; }),
    };
  }
  full(g: GroupDoc, limit = 300) { return { ...this.summary(g), messages: g.messages.slice(-limit) }; }
  private changed(g: GroupDoc) { this.d.broadcast({ type: "group", group: this.summary(g) }); }

  create(name: string, members: GroupMember[], lead?: string): GroupDoc {
    let id = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40);
    if (!id || this.docs.has(id)) id = `g-${crypto.randomBytes(4).toString("hex")}`;
    const uniq = [...new Map(members.filter((m) => this.resolve(m)).map((m) => [memberKey(m), m])).values()];
    const g: GroupDoc = { id, name: name.slice(0, 60), members: uniq, lead: lead && uniq.some((m) => memberKey(m) === lead) ? lead : uniq[0] ? memberKey(uniq[0]) : undefined, created: Date.now(), nextId: 1, chain: 0, messages: [] };
    this.docs.set(id, g);
    this.save(g);
    this.changed(g);
    return g;
  }
  update(g: GroupDoc, b: { name?: string; members?: GroupMember[]; lead?: string }) {
    if (b.name) g.name = b.name.slice(0, 60);
    if (b.members) g.members = [...new Map(b.members.filter((m) => this.resolve(m)).map((m) => [memberKey(m), m])).values()];
    if (b.lead !== undefined) g.lead = g.members.some((m) => memberKey(m) === b.lead) ? b.lead : undefined;
    if (g.lead && !g.members.some((m) => memberKey(m) === g.lead)) g.lead = g.members[0] ? memberKey(g.members[0]) : undefined;
    this.save(g);
    this.changed(g);
  }
  remove(g: GroupDoc) {
    this.docs.delete(g.id);
    try { fs.unlinkSync(path.join(this.dir, `${g.id}.json`)); } catch {}
    this.d.broadcast({ type: "group_removed", id: g.id });
  }

  private append(g: GroupDoc, from: string, name: string, text: string, color?: string): GroupMessage {
    const msg: GroupMessage = { id: g.nextId++, ts: Date.now(), from, name, text: text.slice(0, 8000), ...(color ? { color } : {}) };
    g.messages.push(msg);
    if (g.messages.length > KEEP) g.messages.splice(0, g.messages.length - KEEP);
    this.save(g);
    this.d.broadcast({ type: "group_message", group: g.id, message: msg });
    this.changed(g);
    return msg;
  }
  private note(g: GroupDoc, text: string) { this.append(g, "system", "", text); }

  /** Who a message asks to answer: the members named with @, excluding the writer; @all (boss only) asks everyone.
   *  Longer names are matched first and taken out, so "@المدير العام" is not also read as a member called "المدير". */
  private mentioned(g: GroupDoc, text: string, from?: GroupMember, allowAll = true): GroupMember[] {
    let hay = nameKey(text);
    const others = g.members.filter((m) => !from || memberKey(m) !== memberKey(from));
    if (allowAll && ALL.some((a) => hay.includes("@" + a))) return others;
    const names = others.flatMap((m) => { const e = this.resolve(m); return e ? [{ m, key: nameKey(e.cfg.name) }, { m, key: nameKey(e.cfg.id) }] : []; })
      .filter((x) => x.key).sort((a, b) => b.key.length - a.key.length);
    const hit: GroupMember[] = [];
    for (const { m, key } of names) {
      if (!hay.includes("@" + key)) continue;
      hay = hay.split("@" + key).join(" ");
      if (!hit.includes(m)) hit.push(m);
    }
    return hit;
  }

  /** The boss writes in the group. */
  postFromBoss(g: GroupDoc, text: string) {
    g.chain = 0;
    g.paused = false;
    this.append(g, "boss", t("server.meeting.boss"), text);
    let ask = this.mentioned(g, text);
    if (!ask.length) { const lead = g.members.find((m) => memberKey(m) === g.lead) ?? g.members[0]; if (lead) ask = [lead]; }
    for (const m of ask) this.ask(g, m, true);
  }

  /** An employee writes in the group (its answer, or the post_to_group tool). */
  postFromEmployee(g: GroupDoc, e: Employee, text: string) {
    const me = this.memberOf(g, e);
    this.append(g, me ? memberKey(me) : `${e.cfg.officeId}/${e.cfg.id}`, e.cfg.name, text, e.cfg.color);
    const ask = this.mentioned(g, text, me, false).slice(0, AGENT_MENTIONS);
    if (!ask.length) return;
    if (g.paused) return;
    for (const m of ask) {
      if (++g.chain > MAX_CHAIN) {
        g.paused = true;
        this.epochs.set(g.id, (this.epochs.get(g.id) ?? 0) + 1);
        this.save(g);
        this.note(g, t("server.groups.paused", { n: MAX_CHAIN }));
        return;
      }
      this.ask(g, m, false);
    }
    this.save(g);
  }

  /** One member answers. Members answer in parallel; one employee answers one group question at a time. A busy member does not
   *  hold anyone up: the group is told, and the answer comes when they are free. Whatever goes wrong is said in the group. */
  private ask(g: GroupDoc, m: GroupMember, byBoss: boolean) {
    const e = this.resolve(m);
    if (!e) return;
    const epoch = this.epochs.get(g.id) ?? 0;
    const run = (this.locks.get(e) ?? Promise.resolve()).then(async () => {
      if (!this.docs.has(g.id)) return;
      if (!byBoss && (g.paused || (this.epochs.get(g.id) ?? 0) !== epoch)) return; // the group paused meanwhile
      const key = memberKey(m);
      if (e.busy) this.note(g, t("server.groups.busy", { name: e.cfg.name }));
      const typing = this.typing.get(g.id) ?? new Set<string>();
      typing.add(key); this.typing.set(g.id, typing); this.changed(g);
      let res: Awaited<ReturnType<Employee["sendGroup"]>> = { text: "" };
      try { res = await e.sendGroup(this.prompt(g, e)); }
      catch (err) { res = { text: "", error: (err as Error).message }; }
      finally { typing.delete(key); this.changed(g); }
      if (!this.docs.has(g.id)) return;
      const reply = res.text.trim();
      if (res.skipped) return this.note(g, t(res.skipped === "meeting" ? "server.groups.inMeeting" : "server.groups.stillBusy", { name: e.cfg.name }));
      if (!reply && res.error) {
        // the employee's chat says "The turn ended with an error: …": the group needs only the "…"
        const prefix = t("server.turnError", { detail: "" }).trim();
        const error = res.error.startsWith(prefix) ? res.error.slice(prefix.length).trim() : res.error;
        return this.failNote(g, e.cfg.name, error === "timeout" ? "timeout" : error.replace(/\s+/g, " ").slice(0, 240));
      }
      if (!reply || /^[—–-]+$/.test(reply) || (!byBoss && isCourtesy(reply))) return;
      this.postFromEmployee(g, e, reply);
    });
    this.locks.set(e, run.catch(() => {}));
  }

  // Answers that fail together (the same error for many members, e.g. Hermes is down) are said in one line, not one each.
  private failNote(g: GroupDoc, name: string, error: string) {
    let f = this.failures.get(g.id);
    if (!f) { f = { timer: setTimeout(() => this.flushFailures(g), 2500), byError: new Map() }; this.failures.set(g.id, f); }
    const who = f.byError.get(error) ?? [];
    who.push(name);
    f.byError.set(error, who);
  }
  private flushFailures(g: GroupDoc) {
    const f = this.failures.get(g.id);
    this.failures.delete(g.id);
    if (!f || !this.docs.has(g.id)) return;
    const sep = t("server.groups.sep");
    for (const [error, names] of f.byError) {
      const who = names.length <= 3 ? names.join(sep) : t("server.groups.manyNames", { names: names.slice(0, 3).join(sep), n: names.length - 3 });
      this.note(g, error === "timeout" ? t("server.groups.timeout", { name: who }) : t("server.groups.failed", { name: who, error }));
    }
  }

  private prompt(g: GroupDoc, e: Employee): string {
    const last = g.messages.slice(-HISTORY_LINES).map((x) => x.from === "system" ? `(${x.text})` : `${x.name}: ${x.text.replace(/\s+/g, " ").slice(0, 600)}`).join("\n");
    const members = g.members.map((m) => { const x = this.resolve(m); return x ? `- ${x.cfg.name} — ${x.cfg.role}` : ""; }).filter(Boolean).join("\n");
    return t("server.groups.turn", { group: g.name, name: e.cfg.name, history: last || "-", members });
  }

  /** One group per office, with everybody in it and its first employee as the lead. Offices that already have one are skipped. */
  fromOffices(): number {
    let n = 0;
    for (const o of this.d.everyone()) {
      if (!o.employees.length || [...this.docs.values()].some((g) => g.name === o.officeName)) continue;
      // the lead: the general manager if he sits here, else the office's project manager, else whoever looks like its head
      const rank = (e: Employee) => { const id = (e.cfg.model?.startsWith("hermes:") ? e.cfg.model.slice(7) : e.cfg.id).toLowerCase();
        return id === "gm" ? 3 : e.cfg.manager ? 2 : /(^|[-_])(manager|head|lead|director|ceo)$/.test(id) || /^(مدير|رئيس)/.test(e.cfg.name) ? 1 : 0; };
      const lead = [...o.employees].sort((a, b) => rank(b) - rank(a))[0];
      this.create(o.officeName, o.employees.map((e) => ({ office: o.office, emp: e.cfg.id })), `${o.office}/${lead.cfg.id}`);
      n++;
    }
    return n;
  }

  /** The office tools that let an employee read and write in its groups (all engines). */
  tools(self: Employee) {
    const text = (s: string, isError = false) => ({ content: [{ type: "text" as const, text: s }], ...(isError ? { isError: true } : {}) });
    const mine = () => this.list().filter((g) => this.memberOf(g, self));
    const pick = (name: string) => { const g = this.find(name); return g && this.memberOf(g, self) ? g : undefined; };
    return [
      tool("list_groups", t("server.groups.listDesc"), {}, async () => {
        const gs = mine();
        return text(gs.length ? gs.map((g) => `- ${g.name} (${g.members.length}) — ${g.messages.at(-1) ? `${g.messages.at(-1)!.name}: ${g.messages.at(-1)!.text.slice(0, 80)}` : "-"}`).join("\n") : t("server.groups.none"));
      }),
      tool("read_group", t("server.groups.readDesc"), { group: z.string().describe(t("server.groups.groupDesc")), limit: z.number().optional() }, async ({ group, limit }) => {
        const g = pick(group);
        if (!g) return text(t("server.groups.notFound", { name: group, list: mine().map((x) => x.name).join(", ") || "-" }), true);
        const n = Math.max(5, Math.min(100, limit ?? 30));
        return text(g.messages.slice(-n).map((x) => `${new Date(x.ts).toISOString().slice(5, 16).replace("T", " ")} ${x.from === "system" ? "·" : x.name + ":"} ${x.text}`).join("\n") || "-");
      }),
      tool("post_to_group", t("server.groups.postDesc"), { group: z.string().describe(t("server.groups.groupDesc")), message: z.string() }, async ({ group, message }) => {
        if (self.inGroupTurn) return text(t("server.groups.answerDirectly"), true);
        const g = pick(group);
        if (!g) return text(t("server.groups.notFound", { name: group, list: mine().map((x) => x.name).join(", ") || "-" }), true);
        this.postFromEmployee(g, self, message.trim());
        return text(t("server.groups.posted", { name: g.name }));
      }),
    ];
  }
}

const GROUP_TOOLS = ["list_groups", "read_group", "post_to_group"];

/** The REST side of the groups (the page talks to these; live updates go out as "group…" websocket messages). */
export function mountGroups(app: Express, d: GroupsDeps): Groups {
  const groups = new Groups(d);
  addOfficeTools((self) => groups.tools(self), GROUP_TOOLS);
  const members = (v: unknown): GroupMember[] => Array.isArray(v) ? v.filter((m) => m && typeof m.office === "string" && typeof m.emp === "string").map((m) => ({ office: m.office, emp: m.emp })) : [];
  const str = (v: unknown, n: number) => (typeof v === "string" ? v.trim().slice(0, n) : "");
  app.get("/api/groups", (_req, res) => res.json({ groups: groups.list().map((g) => groups.summary(g)) }));
  app.post("/api/groups", (req, res) => {
    const name = str(req.body?.name, 60);
    const ms = members(req.body?.members);
    if (!name || !ms.length) return res.status(400).json({ error: t("server.groups.needNameMembers") });
    res.json(groups.full(groups.create(name, ms, str(req.body?.lead, 200) || undefined)));
  });
  app.post("/api/groups/from-offices", (_req, res) => res.json({ ok: true, added: groups.fromOffices() }));
  app.get("/api/groups/:id", (req, res) => { const g = groups.get(req.params.id); return g ? res.json(groups.full(g, Number(req.query.limit) || 300)) : res.status(404).json({ error: t("server.notFound") }); });
  app.put("/api/groups/:id", (req, res) => {
    const g = groups.get(req.params.id);
    if (!g) return res.status(404).json({ error: t("server.notFound") });
    groups.update(g, { name: str(req.body?.name, 60) || undefined, members: req.body?.members ? members(req.body.members) : undefined, lead: req.body?.lead !== undefined ? str(req.body.lead, 200) : undefined });
    res.json(groups.full(g));
  });
  app.delete("/api/groups/:id", (req, res) => { const g = groups.get(req.params.id); if (!g) return res.status(404).json({ error: t("server.notFound") }); groups.remove(g); res.json({ ok: true }); });
  app.post("/api/groups/:id/messages", (req, res) => {
    const g = groups.get(req.params.id);
    if (!g) return res.status(404).json({ error: t("server.notFound") });
    const text = str(req.body?.text, 8000);
    if (!text) return res.status(400).json({ error: t("server.textRequired") });
    groups.postFromBoss(g, text);
    res.json({ ok: true });
  });
  return groups;
}
