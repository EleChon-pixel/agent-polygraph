import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const readme = fs.readFileSync(new URL("../README.md", import.meta.url), "utf8");

test("README describes published commands without stale release-state claims", () => {
  assert.match(readme, /agent-polygraph explain --since/);
  assert.match(readme, /agent-polygraph doctor/);
  assert.match(readme, /npm view agent-polygraph version/);
  assert.doesNotMatch(readme, /upcoming `\d+\.\d+\.\d+` release/i);
  assert.doesNotMatch(readme, /currently published npm `\d+\.\d+\.\d+`/i);
  assert.doesNotMatch(readme, /public npm release is currently \*\*\d+\.\d+\.\d+\*\*/i);
  assert.doesNotMatch(readme, /until approval of `\d+\.\d+\.\d+`/i);
});
