# Publishing agent-polygraph to npm

The npm registry currently has `agent-polygraph@0.1.0`; the GitHub repository prepares **0.2.0** with security hardening and cross-platform fixes. **A commit on GitHub is not an npm publication.**

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

## Stage and approve 0.2.0

After configuring the npm trusted publisher and confirming that CI is green:

1. Open [GitHub Actions → Stage npm release (trusted publisher)](https://github.com/EleChon-pixel/agent-polygraph/actions/workflows/publish-npm.yml).
2. Choose **Run workflow**, branch `main`, version `0.2.0`.
3. The workflow validates the package and uses `npm stage publish` with short-lived GitHub OIDC credentials. This **stages** the tarball but does **not** make `0.2.0` publicly installable yet.
4. On npmjs.com, open the **Staged Packages** tab, review the staged package and approve it with your account's **2FA**. Wait for npm's malware scan to finish if approval is unavailable.
5. Check that `npm view agent-polygraph version` reports `0.2.0`. Run `npx --yes agent-polygraph@0.2.0 --demo` on a clean machine. Only then should the README advertise it as the npm release.

**Never try to republish an existing npm version**; npm versions are immutable. For later releases, bump `package.json` and `.claude-plugin/plugin.json` together, then use the new version in the workflow's manual input.

## Troubleshooting npm staging authentication

If GitHub Actions fails at `npm stage publish` with `E401` but tests and package validation pass, inspect the **Stage with GitHub OIDC** job and the npm trusted-publisher identity.

The earlier release attempt failed because `actions/setup-node@v6` was configured with `registry-url`. That version generates an npm `_authToken` placeholder pointing to `NODE_AUTH_TOKEN`, even when there is no token. npm then attempts token authentication rather than the GitHub OIDC exchange and returns E401. The release workflow now omits `registry-url`, uses the default official npm registry and checks that OIDC is present and no token credentials are configured before staging. The [reported setup-node issue](https://github.com/actions/setup-node/issues/1551) documents this failure mode.

If authentication still fails, check the npm Trusted Publisher settings match *exactly*: owner `EleChon-pixel`, repository `agent-polygraph`, workflow filename `publish-npm.yml`, and **no environment name**. Keep direct `npm publish` permission unchecked; staged publishing is sufficient. npm verifies these attributes at publish time, not on saving the form. Do not add a personal npm token as a workaround; that would defeat the trusted-publishing design.

## Recovery for installed hooks

Installing or uninstalling the Claude Code/Codex hooks and modifying `~/.bashrc` or `~/.zshrc` now makes an owner-only backup of the original settings file before applying an atomic rename. The command prints each backup's exact location. Defaults are under `~/.agent-polygraph/backups` (or `$AGENT_POLYGRAPH_HOME/backups`). Backups may contain confidential original settings; don't commit or upload them. To restore, copy the desired backup over the exact original settings file after inspecting it. The installer preserves existing file permissions when replacing files, uses 0600 for newly created files on Unix, refuses symlinks and hard-linked configuration files, and aborts on detected concurrent modification.

## Supported environment matrix

GitHub Actions currently runs the unit and replay tests on Ubuntu with Node 18/20/22/24 and macOS/Windows with Node 22. The live test-execution benchmark runs on Ubuntu with Node 22 only. Shell integration is supported for interactive Bash/Zsh; Windows shell hook support is **not** claimed.

For independent accuracy research, see [issue #3](https://github.com/EleChon-pixel/agent-polygraph/issues/3); it is deliberately outside release readiness.
