# Publishing agent-polygraph to npm

**Published:** `agent-polygraph@0.2.0` is live as npm's `latest` release. The successful [staging run](https://github.com/EleChon-pixel/agent-polygraph/actions/runs/41253375793) used GitHub OIDC and signed provenance. A later [npm registry verification](https://github.com/EleChon-pixel/agent-polygraph/actions/runs/41252503387) confirmed `latest` returned **0.2.0** and the correct GitHub repository. A GitHub commit alone does not publish a new npm release. The 0.2.0 tarball's bundled README contains a now-outdated prerelease notice, because npm versions are immutable; the GitHub README has been corrected.

## One-time owner setup (requires your npm account)

Configure **Trusted Publishing** on the existing [npm package](https://www.npmjs.com/package/agent-polygraph) under Package settings → Trusted Publisher → GitHub Actions.

Use these exact fields:

- GitHub owner: `EleChon-pixel`
- Repository: `agent-polygraph`
- Workflow filename: `publish-npm.yml`
- Environment name: leave blank (the workflow has no GitHub environment)
- Allowed actions: leave **npm publish** unchecked; **npm stage publish** is permitted by default. No direct or dist-tag permissions are needed.

The configuration is an action only the npm package owner can authorize. Do **not** paste npm access tokens into GitHub workflows or this repository. New npm trusted-publisher registrations require a successful first publish within 48 hours to validate the configuration; stage the package and approve it promptly. See [official npm guidance](https://docs.npmjs.com/trusted-publishers/).

## Verify readiness

The [npm package readiness workflow](../.github/workflows/npm-readiness.yml) runs `scripts/release-check.mjs` on Node 24. It checks `npm pack` contents, rejects unsafe filenames, installs the actual tarball into an isolated directory *offline*, runs the packaged CLI and demo, and inspects public npm registry metadata.

A local check from a cloned repository:

```sh
npm test
node scripts/release-check.mjs
```

## Stage and approve a future version

For a **new**, not-yet-published version, update `package.json` and `.claude-plugin/plugin.json` to the same version, commit the changes to `main`, and confirm CI is green. Then:

1. Open [GitHub Actions → Stage npm release (trusted publisher)](https://github.com/EleChon-pixel/agent-polygraph/actions/workflows/publish-npm.yml).
2. Choose **Run workflow**, branch `main`, and enter the **new version** (not `0.2.0`, which is already published).
3. The workflow validates the package and uses `npm stage publish` with short-lived GitHub OIDC credentials. This **stages** the tarball but does **not** make `0.2.0` publicly installable yet.
4. On npmjs.com, open the **Staged Packages** tab, review the new version and approve it with your account's **2FA**. Wait for npm's malware scan to finish if approval is unavailable.
5. Confirm `npm view agent-polygraph version` reports the new version, then test `npx --yes agent-polygraph@<new-version> --demo` on a clean machine. Only after successful npm publication should the README advertise that new version as live.

**Never try to republish an existing npm version**; npm versions are immutable. For later releases, bump `package.json` and `.claude-plugin/plugin.json` together, then use the new version in the workflow's manual input.

## Verify the live npm package

A separate [published npm verification workflow](../.github/workflows/verify-published-npm.yml) runs `scripts/verify-published-npm.mjs`. It checks the public npm `latest` metadata, exact version, package repository, SHA-512 integrity metadata, installs that exact version from npm into a clean temporary prefix and runs the published CLI's `--version` and `--demo` commands. This check uses **the downloaded npm package**, not the GitHub checkout tarball, and never stages or publishes anything.

For the 0.2.0 release you can also run:

```sh
npm view agent-polygraph version
npx --yes agent-polygraph@0.2.0 --demo
```

## Troubleshooting npm staging authentication

If GitHub Actions fails at `npm stage publish` with `E401` but tests and package validation pass, inspect the **Stage with GitHub OIDC** job and the npm trusted-publisher identity.

The earlier release attempt failed because `actions/setup-node@v6` was configured with `registry-url`. That version generates an npm `_authToken` placeholder pointing to `NODE_AUTH_TOKEN`, even when there is no token. npm then attempts token authentication rather than the GitHub OIDC exchange and returns E401. The release workflow now omits `registry-url`, uses the default official npm registry and checks that OIDC is present and no token credentials are configured before staging. The [reported setup-node issue](https://github.com/actions/setup-node/issues/1551) documents this failure mode.

If authentication still fails, check the npm Trusted Publisher settings match *exactly*: owner `EleChon-pixel`, repository `agent-polygraph`, workflow filename `publish-npm.yml`, and **no environment name**. Keep direct `npm publish` permission unchecked; staged publishing is sufficient. npm verifies these attributes at publish time, not on saving the form. Do not add a personal npm token as a workaround; that would defeat the trusted-publishing design.

### Verified failure: npm trusted-publisher registration mismatch (31 October 2026)

The third staging attempt, [run 41252788734](https://github.com/EleChon-pixel/agent-polygraph/actions/runs/41252788734), passed all tests, npm package validation and OIDC environment checks, but `npm stage publish` returned `ENEEDAUTH`. A separate **no-publish OIDC exchange diagnostic** ([run 41252910997](https://github.com/EleChon-pixel/agent-polygraph/actions/runs/41252910997)) directly requested npm's documented `POST /-/npm/v1/oidc/token/exchange/package/agent-polygraph` endpoint and received **HTTP 404**.

GitHub issued a token with these exact non-secret identity claims:

- repository: `EleChon-pixel/agent-polygraph`
- workflow_ref: `EleChon-pixel/agent-polygraph/.github/workflows/publish-npm.yml@refs/heads/main`
- audience: `npm:registry.npmjs.org`
- event: `push` (a diagnostic-only run)

The HTTP 404 means the npm registry did not issue a trusted-publisher token for that identity; the package is already public, so an absent package is not the likely explanation. **The npm Trusted Publisher configuration must be inspected in the owner's npm account.** The original form may have been filled with a full GitHub URL in the Repository field; npm needs only `agent-polygraph`. If a saved entry is wrong, correct or remove/recreate that entry. Ensure that the entry is associated with the existing `agent-polygraph` npm package and the right npm owner account, not another package. Do **not** disable 2FA, add an npm token, or enable direct publishing.

The staging workflow now runs `scripts/verify-npm-oidc.mjs` **before** test execution. It safely prints only non-secret OIDC identity claims and the exchange HTTP status; it never prints a token, stages a package or publishes during the check. Once npm accepts the trust identity (HTTP 201), the same manual workflow can continue to stage `0.2.0`. For authoritative guidance see [npm trusted publishers](https://docs.npmjs.com/trusted-publishers/).

## Recovery for installed hooks

Installing or uninstalling the Claude Code/Codex hooks and modifying `~/.bashrc` or `~/.zshrc` now makes an owner-only backup of the original settings file before applying an atomic rename. The command prints each backup's exact location. Defaults are under `~/.agent-polygraph/backups` (or `$AGENT_POLYGRAPH_HOME/backups`). Backups may contain confidential original settings; don't commit or upload them. To restore, copy the desired backup over the exact original settings file after inspecting it. The installer preserves existing file permissions when replacing files, uses 0600 for newly created files on Unix, refuses symlinks and hard-linked configuration files, and aborts on detected concurrent modification.

## Supported environment matrix

GitHub Actions currently runs the unit and replay tests on Ubuntu with Node 18/20/22/24 and macOS/Windows with Node 22. The live test-execution benchmark runs on Ubuntu with Node 22 only. Shell integration is supported for interactive Bash/Zsh; Windows shell hook support is **not** claimed.

For independent accuracy research, see [issue #3](https://github.com/EleChon-pixel/agent-polygraph/issues/3); it is deliberately outside release readiness.
