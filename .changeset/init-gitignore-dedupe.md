---
"clerk": patch
---

Stop adding a duplicate `.clerk/` line to `.gitignore` when the folder is already ignored under an equivalent pattern such as `/.clerk/`, `.clerk`, or `.clerk/*`.
