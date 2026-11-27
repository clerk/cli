---
"clerk": minor
---

Add `--password-hashes <path>` to `clerk migrate export workos`. It takes the password hash CSV that WorkOS support sends and adds each hash to the user with the same email, so imported users keep their WorkOS passwords. The `workos` source picks the hasher for each user from the hash prefix. Formats Clerk can't verify, such as `$argon2d$` and `$firebase-scrypt$`, are dropped, and those users reset their password.
