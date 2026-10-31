import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runHook, install, uninstall } from "../src/guard.js";

const dir = () => fs.mkdtempSync(path.join(os.tmpdir(), "polygraph-guard-"));
const at = (s) => new Date(Date.UTC(2026, 9, 1, 12, 0, s)).toISOString();

function transcript(events) {
  const file = path.join(dir(), "s.jsonl");
  fs.writeFileSync(file, events.map((e) => JSON.stringify({ cwd: "/repo", sessionId: "s", ...e })).join("\n") + "\n");
  return file;
}
const user = (s, text) => ({ type: "user", timestamp: at(s), origin: { kind: "human" }, message: { content: text } });
const tool = (s, id, name, input) => ({ type: "assistant", timestamp: at(s), message: { content: [{ type: "tool_use", id, name, input }] } });
const result = (s, id, text) => ({ type: "user", timestamp: at(s), message: { content: [{ type: "tool_result", tool_use_id: id, content: text }] } });
const say = (s, text) => ({ type: "assistant", timestamp: at(s), message: { content: [{ type: "text", text }] } });

const run = [tool(1, "a", "Bash", { command: "npm test" }), result(2, "a", "ℹ pass 3\nℹ fail 0")];
const edit = [tool(3, "b", "Edit", { file_path: "/repo/src/x.js", old_string: "1", new_string: "2" }), result(3, "b", "The file /repo/src/x.js has been updated successfully.")];

test("blocks an unbacked claim in the final turn", async () => {
  const file = transcript([user(0, "fix x"), ...run, ...edit, say(4, "Done. All tests pass.")]);
  const out = await runHook(JSON.stringify({ transcript_path: file, stop_hook_active: false }));
  assert.equal(out.decision, "block");
  assert.match(out.reason, /edited src\/x\.js after the last test run/);
});

test("lets a backed claim through", async () => {
  const file = transcript([user(0, "fix x"), ...edit, ...run.map((e) => ({ ...e, timestamp: at(5) })), say(6, "All tests pass.")]);
  assert.equal(await runHook(JSON.stringify({ transcript_path: file })), null);
});

test("never blocks twice in a row", async () => {
  const file = transcript([user(0, "fix x"), ...run, ...edit, say(4, "All tests pass.")]);
  assert.equal(await runHook(JSON.stringify({ transcript_path: file, stop_hook_active: true })), null);
});

test("ignores claims from earlier turns", async () => {
  const file = transcript([user(0, "fix x"), ...run, ...edit, say(4, "All tests pass."), user(5, "thanks, now rename y"), say(6, "Renamed.")]);
  assert.equal(await runHook(JSON.stringify({ transcript_path: file })), null);
});

test("uses last_assistant_message when the transcript lags", async () => {
  const file = transcript([user(0, "fix x"), ...run, ...edit]);
  const out = await runHook(JSON.stringify({ transcript_path: file, last_assistant_message: "Fixed; tests pass." }));
  assert.equal(out?.decision, "block");
});

test("bad input never throws", async () => {
  assert.equal(await runHook("not json"), null);
  assert.equal(await runHook(JSON.stringify({ transcript_path: "/nope.jsonl" })), null);
});

test("install is idempotent and uninstall keeps other hooks", () => {
  const cwd = dir();
  const settings = path.join(cwd, ".claude", "settings.json");
  fs.mkdirSync(path.dirname(settings), { recursive: true });
  fs.writeFileSync(settings, JSON.stringify({ model: "x", hooks: { Stop: [{ hooks: [{ type: "command", command: "say done" }] }] } }));
  const opts = { cwd, agents: ["claude"], command: "agent-polygraph guard" };
  assert.equal(install(opts)[0].changed, true);
  assert.equal(install(opts)[0].changed, false);
  assert.equal(JSON.parse(fs.readFileSync(settings, "utf8")).hooks.Stop.length, 2);
  assert.equal(uninstall(opts)[0].changed, true);
  const after = JSON.parse(fs.readFileSync(settings, "utf8"));
  assert.deepEqual(after, { model: "x", hooks: { Stop: [{ hooks: [{ type: "command", command: "say done" }] }] } });
});

test("plugin hook steps aside when settings already have a guard hook", async () => {
  const { settingsHasGuard } = await import("../src/guard.js");
  const home = dir(); // stands in for ~/.claude
  const project = dir();
  const sub = path.join(project, "packages", "app");
  fs.mkdirSync(sub, { recursive: true });
  const prev = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = home;
  try {
    const file = transcript([user(0, "fix x"), ...run, ...edit, say(4, "Done. All tests pass.")]);
    const payload = JSON.stringify({ transcript_path: file, cwd: sub });
    assert.equal(settingsHasGuard(sub), false);
    assert.equal((await runHook(payload, { plugin: true })).decision, "block");

    // a project-level install above cwd counts
    install({ agents: ["claude"], cwd: project, command: "agent-polygraph guard" });
    assert.equal(settingsHasGuard(sub), true);
    assert.equal(await runHook(payload, { plugin: true }), null);
    assert.equal((await runHook(payload)).decision, "block"); // the settings hook itself still runs

    // so does a user-level one; a record hook doesn't
    uninstall({ agents: ["claude"], cwd: project });
    install({ agents: ["claude"], cwd: project, command: "agent-polygraph record" });
    assert.equal(settingsHasGuard(sub), false);
    fs.writeFileSync(path.join(home, "settings.json"), JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: "command", command: "npx -y agent-polygraph@0.1.0 guard" }] }] } }));
    assert.equal(settingsHasGuard(sub), true);
  } finally {
    if (prev === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = prev;
  }
});

test("Claude Code plugin manifests match the package", () => {
  const root = new URL("../", import.meta.url);
  const read = (p) => JSON.parse(fs.readFileSync(new URL(p, root), "utf8"));
  const pkg = read("package.json");
  const plugin = read(".claude-plugin/plugin.json");
  const market = read(".claude-plugin/marketplace.json");
  assert.equal(plugin.name, pkg.name);
  assert.equal(plugin.version, pkg.version);
  assert.deepEqual(market.plugins.map((p) => [p.name, p.source]), [[pkg.name, "./"]]);
  const cmd = read("hooks/hooks.json").hooks.Stop[0].hooks[0].command;
  assert.match(cmd, /^node "\$\{CLAUDE_PLUGIN_ROOT\}\/bin\/polygraph\.js" guard --from-plugin$/);
  assert.ok(fs.existsSync(new URL("bin/polygraph.js", root)));
});
