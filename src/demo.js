// `--demo`: write synthetic Claude Code and Codex sessions to a temp dir and report on
// them, so people can see the output (and screenshots never contain anyone's real data).
// The numbers are invented; they say nothing about how real agents behave.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export function makeDemo(seed = 11) {
  const rand = mulberry32(seed);
  const pick = (xs) => xs[Math.floor(rand() * xs.length)];
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "polygraph-demo-"));
  const claudeDir = path.join(root, "claude");
  const codexDir = path.join(root, "codex");
  const start = Date.UTC(2026, 7, 10, 9);

  const projects = ["shop-api", "billing-service", "web-dashboard", "cli-tools", "data-pipeline"];
  const runners = [
    { full: "pytest -q", focused: "pytest -q tests/test_orders.py", pass: (n) => `${n} passed in 3.2s`, fail: (n) => `2 failed, ${n} passed in 3.4s`, src: "src/orders.py", test: "tests/test_orders.py" },
    { full: "npm test", focused: "npx vitest run src/cart.test.ts", pass: (n) => `Tests:  ${n} passed, ${n} total`, fail: (n) => `Tests:  1 failed, ${n} passed, ${n + 1} total`, src: "src/cart.ts", test: "src/cart.test.ts" },
    { full: "go test ./...", focused: "go test ./pkg/billing", pass: () => "ok  \tapp/pkg/billing\t0.41s", fail: () => "--- FAIL: TestInvoice (0.00s)\nFAIL", src: "pkg/billing/invoice.go", test: "pkg/billing/invoice_test.go" },
  ];

  let t = start;
  const tick = (s) => (t += s * 1000);
  const iso = () => new Date(t).toISOString();

  for (let i = 0; i < 120; i++) {
    const agent = i % 2 ? "codex" : "claude";
    const project = pick(projects);
    const cwd = `/work/${project}`;
    const r = pick(runners);
    t = start + i * 12 * 3600 * 1000 + Math.floor(rand() * 4 * 3600 * 1000);
    const ev = []; // abstract events, rendered per agent below

    ev.push(["user", pick(["fix the failing checkout flow", "add retries to the invoice job", "the cart total is off by one", "refactor the order service"])]);
    const runs = 2 + Math.floor(rand() * 5);
    let n = 40 + Math.floor(rand() * 300);
    for (let k = 0; k < runs; k++) {
      const full = rand() < 0.3;
      const fails = rand() < 0.22;
      ev.push(["edit", r.src, ["    total = subtotal"], ["    total = subtotal + tax"]]);
      ev.push(["test", full ? r.full : r.focused, fails ? r.fail(n) : r.pass(n), fails ? 1 : 0, full ? 60 + rand() * 300 : 4 + rand() * 30]);
      if (fails && rand() < 0.05) {
        // rewrite the assertion instead of the code, then rerun
        ev.push(["edit", r.test, ["    assert total == 108", "    assert len(lines) == 3"], ["    assert total"]]);
        ev.push(["test", r.focused, r.pass(n), 0, 6]);
      }
    }
    const roll = rand();
    // the same odds for both agents (the demo must not suggest one is better), in the
    // range real logs show: most claims backed, a few stale, rarely after a failure
    const ok = 0.91;
    if (roll < ok) ev.push(["test", r.focused, r.pass(n), 0, 8], ["say", `Done. All ${n} tests pass.`]);
    else if (roll < ok + 0.06) ev.push(["test", r.focused, r.pass(n), 0, 8], ["edit", r.src, ["x"], ["y"]], ["say", "Fixed, and the tests pass."]);
    else ev.push(["test", r.focused, r.fail(n), 1, 8], ["say", `The suite passed: ${n} tests.`]);
    if (rand() < 0.25) ev.push(["user", pick(["no, don't change the public API", "I told you not to touch the migrations", "revert that last change"])]);

    if (agent === "claude") writeClaude(claudeDir, project, `demo-${i}`, cwd, ev, tick, iso, pick(["claude-opus-5-5", "claude-sonnet-5-5"]));
    else writeCodex(codexDir, `demo-${i}`, cwd, ev, tick, iso, pick(["gpt-6-sol", "gpt-6-astra"]));
  }
  return { root, claudeDir, codexDir };
}

function writeClaude(dir, project, id, cwd, ev, tick, iso, model) {
  const out = [];
  const base = { cwd, sessionId: id, isSidechain: false };
  let n = 0;
  for (const e of ev) {
    tick(5);
    if (e[0] === "user") out.push({ ...base, type: "user", timestamp: iso(), origin: { kind: "human" }, message: { content: e[1] } });
    else if (e[0] === "say") out.push({ ...base, type: "assistant", timestamp: iso(), message: { model, content: [{ type: "text", text: e[1] }] } });
    else if (e[0] === "edit") {
      out.push({ ...base, type: "assistant", timestamp: iso(), message: { model, content: [{ type: "tool_use", id: `t${++n}`, name: "Edit", input: { file_path: `${cwd}/${e[1]}`, old_string: e[2].join("\n"), new_string: e[3].join("\n") } }] } });
      tick(1);
      out.push({ ...base, type: "user", timestamp: iso(), message: { content: [{ type: "tool_result", tool_use_id: `t${n}`, content: "ok" }] } });
    } else if (e[0] === "test") {
      out.push({ ...base, type: "assistant", timestamp: iso(), message: { model, content: [{ type: "tool_use", id: `t${++n}`, name: "Bash", input: { command: e[1] } }] } });
      tick(e[4]);
      const text = (e[3] ? `Exit code ${e[3]}\n` : "") + e[2];
      out.push({ ...base, type: "user", timestamp: iso(), message: { content: [{ type: "tool_result", tool_use_id: `t${n}`, content: text, is_error: !!e[3] }] } });
    }
  }
  const p = path.join(dir, `-work-${project}`);
  fs.mkdirSync(p, { recursive: true });
  fs.writeFileSync(path.join(p, `${id}.jsonl`), out.map((o) => JSON.stringify(o)).join("\n") + "\n");
}

function writeCodex(dir, id, cwd, ev, tick, iso, model) {
  const out = [{ timestamp: iso(), type: "session_meta", payload: { id, cwd } }, { timestamp: iso(), type: "turn_context", payload: { model, cwd } }];
  const item = (payload) => out.push({ timestamp: iso(), type: "response_item", payload });
  let n = 0;
  for (const e of ev) {
    tick(5);
    if (e[0] === "user") item({ type: "message", role: "user", content: [{ type: "input_text", text: e[1] }] });
    else if (e[0] === "say") item({ type: "message", role: "assistant", content: [{ type: "output_text", text: e[1] }] });
    else if (e[0] === "edit") {
      const patch = ["*** Begin Patch", `*** Update File: ${e[1]}`, "@@", ...e[2].map((l) => "-" + l), ...e[3].map((l) => "+" + l), "*** End Patch"].join("\n");
      item({ type: "custom_tool_call", name: "apply_patch", call_id: `c${++n}`, input: patch });
      item({ type: "custom_tool_call_output", call_id: `c${n}`, output: [{ type: "input_text", text: "Success" }] });
    } else if (e[0] === "test") {
      item({ type: "custom_tool_call", name: "exec", call_id: `c${++n}`, input: `const r = await tools.exec_command(${JSON.stringify({ cmd: e[1] })}); text(r.output);` });
      tick(e[4]);
      item({ type: "custom_tool_call_output", call_id: `c${n}`, output: [{ type: "input_text", text: `Script completed\nWall time ${e[4].toFixed(1)} seconds\n${JSON.stringify({ exit_code: e[3], output: e[2] })}` }] });
    }
  }
  const p = path.join(dir, "2026", "09", "01");
  fs.mkdirSync(p, { recursive: true });
  fs.writeFileSync(path.join(p, `rollout-${id}.jsonl`), out.map((o) => JSON.stringify(o)).join("\n") + "\n");
}

function mulberry32(a) {
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
