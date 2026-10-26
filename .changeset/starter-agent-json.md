---
"clerk": minor
---

Agents can create iOS and macOS apps end to end with JSON. `clerk init --starter --framework ios --json` (or `macos`) runs non-interactively and reports a missing name, an existing folder, a Bundle ID, or a team as an `input-required` status before anything is written. Every status after the app is written names it and the command that finishes it, and setup that stops after writing reports `setup-interrupted` instead of leaving an agent to retry `--starter`. A new app that would otherwise inherit a parent's or repository's link asks which application to use.
