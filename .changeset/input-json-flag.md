---
"clerk": minor
---

Add `--input-json` to pass options as JSON for any command. Accepts an inline object or `@path/to/file.json`; keys are converted from camelCase/snake_case to kebab-case flags (e.g. `{"dryRun":true}` → `--dry-run`). Arrays expand to repeated flags, `true` becomes a bare flag, `false`/`null` are omitted. Designed for AI-agent and scripted invocations that prefer passing structured options over composing shell strings.
