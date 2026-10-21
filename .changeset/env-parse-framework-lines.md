---
"clerk": patch
---

Read `.env` lines the way Next.js and other framework loaders do: indented keys, spaces around `=`, Windows line endings, and trailing comments. `clerk env pull` and `clerk init` now update those lines in place instead of appending duplicate Clerk keys.
