// Read-only diagnostic for transcript discovery, hook wiring and local recorder paths.
// Never prints transcript contents, credentials, or raw hook payloads.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SOURCES } from "./scan.js";
import { isOurHook, targets } from "./guard.js";
import { readSettings } from "./safe-config.js";
import { home as recordHome } from "./record.js";

function checkConfig(file, sub) {
  try {
    const { text } = readSettings(file);
    if (text === null) return "not installed";
    const cfg = JSON.parse(text);
    const event = sub === "guard" ? "Stop" : "PostToolUse";
    const hooks = (cfg.hooks?.[event] || []).flatMap((g) => g.hooks || []);
    return hooks.some((h) => isOurHook(h, sub)) ? "installed" : "not installed";
  } catch (e) {
    return `ERROR: invalid or unsafe settings (${e.code || e.name || "error"})`;
  }
}

/** Diagnose local files without mutating settings or running any tests. */
export async function diagnose({ cwd = process.cwd(), roots = {}, agents = ["claude", "codex"], sample = 2, checkCi = false } = {}) {
  const checks = [];
  for (const agent of agents) {
    const src = SOURCES[agent];
    if (!src) continue;
    const root = roots[agent] || src.defaultRoot();
    let entries;
    try { entries = src.discover(root); }
    catch (e) {
      checks.push({ kind: "warn", message: `${agent}: cannot list transcripts (${e.code || e.name})` });
      continue;
    }
    checks.push({ kind: entries.length ? "ok" : "info", message: `${agent}: ${entries.length} session file(s) discovered in ${root}` });
    if (entries.length) {
      const latest = entries.sort((a, b) => b.mtime - a.mtime).slice(0, sample);
      let unsupported = 0, unreadable = 0;
      for (const entry of latest) {
        try { if ((await src.parse(entry)).unrecognized) unsupported++; }
        catch { unreadable++; }
      }
      checks.push({ kind: unsupported || unreadable ? "warn" : "ok", message:
        `${agent}: sampled ${latest.length} session(s); ${unsupported} unrecognized formats, ${unreadable} unreadable` });
    }
    for (const global of [false, true]) {
      const files = targets({ agents: [agent], global, cwd });
      for (const { file } of files) {
        const status = checkConfig(file, "guard");
        checks.push({ kind: status.startsWith("ERROR") ? "warn" : status === "installed" ? "ok" : "info",
          message: `${agent}: ${global ? "global" : "project"} guard ${status} (${file})` });
        const record = checkConfig(file, "record");
        checks.push({ kind: record.startsWith("ERROR") ? "warn" : record === "installed" ? "ok" : "info",
          message: `${agent}: ${global ? "global" : "project"} recorder ${record}` });
      }
    }
  }
  const dir = recordHome();
  try {
    const st = fs.lstatSync(dir);
    const linked = st.isSymbolicLink() || !st.isDirectory();
    const shared = process.platform !== "win32" && (st.mode & 0o077) !== 0;
    checks.push({ kind: linked || shared ? "warn" : "ok", message:
      linked ? "Local recorder directory is not a safe regular directory" :
      shared ? "Local recorder directory permits group/other access" :
      `Local recorder directory exists (${dir})` });
  } catch (e) {
    checks.push({ kind: e.code === "ENOENT" ? "info" : "warn", message:
      e.code === "ENOENT" ? "Local recorder not initialized (optional)" : `Local recorder inaccessible (${e.code || e.name})` });
  }
  if (checkCi) {
    // Explicit opt-in: checking gh login can contact GitHub, unlike the default doctor.
    try {
      const { checkGh } = await import("./ci.js");
      await checkGh();
      checks.push({ kind: "ok", message: "GitHub CLI authentication available for --ci" });
    } catch (e) {
      checks.push({ kind: "warn", message: `GitHub CLI authentication unavailable for --ci: ${e.message}` });
    }
  }
  return checks;
}

export function renderDoctor(checks) {
  const severity = { ok: "OK", warn: "WARN", info: "INFO" };
  const warnings = checks.filter((c) => c.kind === "warn").length;
  return ["agent-polygraph doctor — read-only, local diagnostics",
    ...checks.map((c) => `[${severity[c.kind] || "INFO"}] ${c.message}`),
    "", warnings ? `${warnings} warning(s) require investigation.` : "No diagnostic warnings in the checks performed.",
    "Not-installed hooks are optional; a plugin can supply a separate guard.",
    "This is not a security audit or a substitute for checking actual claim evidence."].join("\n");
}
