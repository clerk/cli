---
"clerk": patch
---

Stop calling a claimed application "unclaimed accountless" when `clerk config` reaches it with only a secret key. With `CLERK_SECRET_KEY` (or a key in `.env`) and no `--app` or linked profile, `clerk config patch`, `put`, `schema` and `--instance` refusals now check whether the application is claimed, and if it is, say to run `clerk auth login` and then `clerk link` or pass `--app <id>`, instead of telling you to claim it.
