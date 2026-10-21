---
"clerk": patch
---

Stop calling a claimed application "unclaimed accountless" when `clerk config` reaches it with only a secret key. With `CLERK_SECRET_KEY` (or a key in `.env`) and no `--app` or linked profile, a `clerk config patch`, `put`, `schema` or `--instance` refusal, or a `clerk enable billing` / `clerk disable billing` refusal, now asks Clerk whether the application belongs to an account. If it does, it says a secret key can't change those settings, and to pass `--app <id> --instance <dev|prod>` (or run `clerk link`) with `clerk auth login` or `CLERK_PLATFORM_API_KEY`; a login alone isn't enough while the secret key is set. If Clerk can't say, the message covers both cases. A default `clerk config pull` of a claimed application warns what the secret key left out.
