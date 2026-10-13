---
"clerk": patch
---

Run in agent mode under OpenAI's Codex CLI, so `clerk init` creates temporary (accountless) keys instead of waiting on a browser login nobody can complete. Codex attaches a terminal to every command, which the TTY check read as a person. All commands now skip prompts and emit agent output under Codex, the same as under Claude Code; pass `--mode human` or set `CLERK_MODE=human` to override. Telemetry's `mode` field reports `agent` for Codex runs from this release.
