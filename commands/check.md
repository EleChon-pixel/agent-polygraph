---
description: Check your agents' "tests pass" claims in past sessions (all projects, or one with an argument)
argument-hint: "[--since 30d] [--project <text>] [other agent-polygraph options]"
allowed-tools: Bash(node:*)
---

Run agent-polygraph on this machine's Claude Code and Codex session logs:

```
node "${CLAUDE_PLUGIN_ROOT}/bin/polygraph.js" --examples 2 $ARGUMENTS
```

Show the user the report's headline numbers and the examples it lists, quoting them as printed. Don't add your own verdicts on top of the tool's, and don't rerun it with different options unless the user asks. If it says a claim "couldn't tell", say that plainly instead of guessing. Mention that `npx agent-polygraph --html` writes a shareable numbers-only report.
