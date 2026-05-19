---
"clerk": patch
---

Disable `bunfig.toml` autoload in the compiled CLI binary. Previously, an attacker-supplied `bunfig.toml` in the current working directory could execute arbitrary JavaScript (via `preload`) before argv parsing on any `clerk` invocation — including `clerk --version` and unknown subcommands. The release and local compile scripts now pass `--no-compile-autoload-bunfig` to `bun build --compile`, mirroring the existing `--no-compile-autoload-dotenv` hardening.
