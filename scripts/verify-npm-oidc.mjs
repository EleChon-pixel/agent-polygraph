#!/usr/bin/env node
// Credential-free display: securely checks GitHub's npm-audience OIDC
// identity and npm's documented exchange endpoint. NEVER logs any JWT,
// Authorization header, registry token, raw response body, or credentials.
// This does not stage or publish any package.
import { readFileSync } from "node:fs";
const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const idUrl = process.env.ACTIONS_ID_TOKEN_REQUEST_URL;
const idAuth = process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;
if (!idUrl || !idAuth || !process.env.GITHUB_ACTIONS) throw Error("GitHub Actions OIDC permissions are missing");

const audience = "npm:registry.npmjs.org";
const url = new URL(idUrl);
url.searchParams.set("audience", audience);
const idResponse = await fetch(url, { headers: { Authorization: `Bearer ${idAuth}` }, signal: AbortSignal.timeout(15000) });
if (!idResponse.ok) throw Error(`GitHub OIDC issuance failed: HTTP ${idResponse.status}`);
const idToken = (await idResponse.json()).value;
if (typeof idToken !== "string" || idToken.split(".").length !== 3) throw Error("GitHub returned an invalid JWT");
const claims = JSON.parse(Buffer.from(idToken.split(".")[1], "base64url").toString("utf8"));
const identity = {
  repository: claims.repository,
  workflow: claims.workflow,
  workflow_ref: claims.workflow_ref,
  job_workflow_ref: claims.job_workflow_ref || null,
  event_name: claims.event_name,
  ref: claims.ref,
  audience: claims.aud,
  issuer: claims.iss,
};
console.log("GitHub OIDC identity (non-secret claims only):", JSON.stringify(identity, null, 2));
if (claims.repository !== "EleChon-pixel/agent-polygraph" ||
    !String(claims.workflow_ref || "").includes("/.github/workflows/publish-npm.yml@") ||
    claims.aud !== audience) {
  throw Error("GitHub OIDC identity does not match the expected repository/workflow/audience");
}
const exchangeUrl = "https://registry.npmjs.org/-/npm/v1/oidc/token/exchange/package/" + encodeURIComponent(pkg.name);
const response = await fetch(exchangeUrl, {
  method: "POST",
  headers: { Authorization: `Bearer ${idToken}`, Accept: "application/json" },
  signal: AbortSignal.timeout(15000),
});
console.log("npm OIDC exchange HTTP status:", response.status);
if (response.status !== 201) {
  // npm's error body could include identifiers or credentials: never print it.
  const hint = response.status === 404
    ? "npm did not find a matching trusted publisher for this package/identity. Check exact npm owner, repo, workflow filename and blank environment."
    : response.status === 401 || response.status === 403
    ? "npm rejected the identity or its permissions. Confirm stage permission and trusted publisher configuration."
    : "npm returned an unexpected status; inspect npm service status and trusted publisher configuration.";
  throw Error(hint);
}
console.log("npm accepted GitHub OIDC for agent-polygraph. No package was staged or published.");
