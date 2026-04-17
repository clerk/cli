---
"clerk": minor
---

Add `clerk skill install` to install the bundled `clerk` Claude Code skill into your project. The skill ships with the CLI and is pinned to the CLI's version, and `clerk init` now offers to install it alongside the framework-pattern skills.

The bundled skill's command reference and agent-mode docs have also been resynced with the CLI: `clerk init --app`, `clerk config patch`/`put` `--app` and `--instance`, and `clerk update` are now documented, agent-mode errors are documented as structured JSON on stderr, the `clerk doctor --json` shape is spelled out in full (`detail`, `fix` alongside `remedy`), `apps create` is noted as auto-emitting JSON in agent mode (same as `apps list`), and the OpenAPI catalog cache TTL is corrected to 1 hour. The auth docs now list the `signup`/`signin`/`sign-in` and `signout`/`sign-out` aliases plus the top-level `clerk login`/`clerk logout` shortcuts, `config patch` explains `--destructive` the same way `config put` does, `config` commands are noted as Platform-API-only (they ignore `--secret-key`), and the agent-mode reference maps each failing `clerk doctor` check to the manual command that would remediate it when `--fix` is unavailable.
