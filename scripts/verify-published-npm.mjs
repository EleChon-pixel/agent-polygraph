#!/usr/bin/env node
// Public npm install verification; this script never publishes or stages.
// Installs only the package version named by package.json into a throwaway directory.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(fileURLToPath(new URL("../", import.meta.url)));
const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const expected = process.env.EXPECTED_NPM_VERSION || pkg.version;
if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(expected))
  throw Error("Invalid exact release version");

const response = await fetch("https://registry.npmjs.org/" + encodeURIComponent(pkg.name) + "/latest", {
  signal: AbortSignal.timeout(15000),
});
if (!response.ok) throw Error("npm registry latest lookup failed: HTTP " + response.status);
const latest = await response.json();
if (latest.name !== pkg.name || latest.version !== expected)
  throw Error("npm latest version mismatch: expected " + pkg.name + "@" + expected +
    ", got " + latest.name + "@" + latest.version);
const repo = String(latest.repository?.url || latest.repository || "").toLowerCase();
if (!repo.includes("elechon-pixel/agent-polygraph"))
  throw Error("Published npm metadata does not point to the expected GitHub repository");
if (!latest.dist?.integrity?.startsWith("sha512-"))
  throw Error("Missing expected sha512 npm package integrity");

const temp = fs.mkdtempSync(path.join(os.tmpdir(), "agent-polygraph-published-"));
function exec(bin, args) {
  const r = spawnSync(bin, args, { cwd: temp, encoding: "utf8", timeout: 120000,
    maxBuffer: 8 << 20, env: { ...process.env, NPM_CONFIG_AUDIT: "false", NPM_CONFIG_FUND: "false" } });
  if (r.status !== 0) throw Error(bin + " " + args.join(" ") + " failed: " +
    String(r.stderr).slice(-2000));
  return r.stdout.trim();
}
try {
  exec(process.platform === "win32" ? "npm.cmd" : "npm", [
    "install", "--ignore-scripts", "--no-audit", "--no-fund", "--prefix", temp,
    pkg.name + "@" + expected,
  ]);
  const installed = JSON.parse(fs.readFileSync(path.join(temp, "node_modules", pkg.name, "package.json"), "utf8"));
  if (installed.version !== expected) throw Error("Installed version mismatch");
  const cli = path.join(temp, "node_modules", pkg.name, "bin", "polygraph.js");
  if (exec(process.execPath, [cli, "--version"]) !== expected) throw Error("Published CLI version mismatch");
  if (!exec(process.execPath, [cli, "--demo"]).includes("agent-polygraph"))
    throw Error("Published CLI demo failed");
  if (!fs.existsSync(path.join(temp, "node_modules", pkg.name, "src", "safe-config.js")))
    throw Error("Published package is missing the security-hardened settings module");
  const isNewRelease = expected.split(".").map(Number)[0] > 0 ||
    Number(expected.split(".")[1]) >= 3;
  if (isNewRelease) {
    const doctor = exec(process.execPath, [cli, "doctor", "--agent", "claude",
      "--claude-dir", path.join(temp, "missing-claude")]);
    if (!doctor.includes("agent-polygraph doctor"))
      throw Error("Published doctor command did not work");
    const explain = exec(process.execPath, [cli, "explain", "--demo", "--limit", "2"]);
    if (!explain.includes("agent-polygraph explain"))
      throw Error("Published explain command did not work");
  }
  const publishedReadme = fs.readFileSync(path.join(temp, "node_modules", pkg.name, "README.md"), "utf8");
  const sourceReadme = fs.readFileSync(path.join(root, "README.md"), "utf8");
  if (publishedReadme !== sourceReadme)
    throw Error("Published README differs from the corrected repository README");
  if (publishedReadme.includes("0.2.0 release candidate") ||
      /upcoming `\d+\.\d+\.\d+` release|currently published npm `\d+\.\d+\.\d+`|public npm release is currently \*\*\d+\.\d+\.\d+\*\*|until approval of `\d+\.\d+\.\d+`/i.test(publishedReadme))
    throw Error("Published README contains obsolete release-status language");
  console.log(JSON.stringify({
    package: pkg.name, publicLatestVersion: latest.version,
    sourceRepositoryVerified: true, sha512IntegrityPresent: true,
    installedFromPublicNpm: true, cliVersionVerified: true, demoPassed: true,
    safeConfigIncluded: true, correctedReadmeVerified: true,
    explainAndDoctorVerified: isNewRelease
  }, null, 2));
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}
