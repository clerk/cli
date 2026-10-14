---
"clerk": minor
---

Add `clerk migrate export firebase`, and let `clerk migrate import` read Firebase exports with their password hashes. The project's hash parameters come from the export, the `--firebase-*` flags, or `CLERK_FIREBASE_SIGNER_KEY`, `CLERK_FIREBASE_SALT_SEPARATOR`, `CLERK_FIREBASE_ROUNDS` and `CLERK_FIREBASE_MEM_COST`.
