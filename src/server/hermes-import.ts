import fs from "node:fs";
import path from "node:path";
import { defaultLook, writeAgentFile } from "./agents.js";
import type { EmployeeConfig } from "./employee.js";
import type { OfficeDef } from "./config.js";
import { getSettings, t } from "./runtime.js";
import { HERMES_PREFIX } from "./hermes.js";

const COLORS = ["#e06c75", "#61afef", "#98c379", "#c678dd", "#e5c07b", "#56b6c2", "#d19a66", "#f78fb3", "#7dd3fc", "#a3e635", "#fb923c", "#f472b6"];

/** Creates <employeesDir>/<profile>/agent.md for one Hermes profile: an employee whose model is "hermes:<profile>".
 *  The folder is named after the profile, so a second import finds it and adds nothing twice. Returns the folder. */
export function writeHermesEmployee(office: OfficeDef, profile: string, name: string, role: string): string {
  let id = profile.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "") || "hermes";
  let dir = path.join(office.employeesDir, id);
  for (let n = 2; fs.existsSync(dir); n++) { id = `${profile}-${n}`; dir = path.join(office.employeesDir, id); }
  fs.mkdirSync(path.join(dir, "skills"), { recursive: true });
  let h = 0;
  for (const ch of profile) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  const color = COLORS[h % COLORS.length];
  const cfg: EmployeeConfig = {
    id, name, role, color, look: defaultLook(profile, color),
    systemPrompt: t("server.hermes.profileBody", { profile }),
    cwd: office.cwd, dir, agentFile: path.join(dir, "agent.md"), officeId: office.id,
    model: HERMES_PREFIX + profile, hired: new Date().toISOString().slice(0, 10), refreshHours: getSettings().refreshHours,
  };
  writeAgentFile(cfg);
  return dir;
}
