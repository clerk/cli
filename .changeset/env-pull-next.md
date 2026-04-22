---
"clerk": patch
---

Default `clerk env pull` to `.env.local` on Next.js projects with no existing env file, matching the framework's convention for local secrets. Projects that already have keys in `.env` continue to write there.
