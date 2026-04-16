---
"clerk": patch
---

Fix `clerk init` prompt flow:

- Skip the keyless / skip-auth confirmation when you are already signed in.
- Keep `clerk init --starter` fully interactive — it no longer fails with "Non-interactive mode requires --framework" when running without `-y`.
