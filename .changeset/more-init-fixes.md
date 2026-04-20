---
"clerk": patch
---

Fix `clerk init` prompt flow:

- When you are signed in (OAuth or `CLERK_PLATFORM_API_KEY`), `clerk init` skips straight to the authenticated flow — no more "Skip authentication for now?" prompt.
- When you are not signed in **during bootstrap** (new projects) on a keyless-capable framework, `clerk init` now goes keyless automatically (previously prompted) and points you to `clerk auth login` for later. Re-runs in an existing project still fall through to the authenticated flow so real keys can be pulled.
- Keep `clerk init --starter` fully interactive — it no longer fails with "Non-interactive mode requires --framework" when running without `-y`.
