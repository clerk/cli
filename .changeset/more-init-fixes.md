---
"clerk": patch
---

Fix `clerk init` prompt flow:

- Skip the keyless / skip-auth confirmation when you are already signed in (including via `CLERK_PLATFORM_API_KEY`).
- Keep `clerk init --starter` fully interactive — it no longer fails with "Non-interactive mode requires --framework" when running without `-y`.
