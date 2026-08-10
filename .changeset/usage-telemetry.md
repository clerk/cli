---
"clerk": minor
---

Collect usage telemetry (command name, flag names, duration, outcome, a random machine identifier — and your workspace and app IDs when a project is linked; never arguments, option values, paths, or personal data). The first run only shows a disclosure notice and sends nothing (CI environments send from the first run), and `--verbose` prints every event before it is sent. Control it with the new `clerk telemetry status|disable|enable` subcommand, or the `CLERK_TELEMETRY_DISABLED` / `DO_NOT_TRACK` environment variables (any non-false value opts out).
