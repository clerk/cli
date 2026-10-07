---
"clerk": patch
---

Register TanStack Start's CSRF middleware before Clerk's middleware in `src/start.ts`, both when `clerk init` creates the file and when it can safely edit an existing one. This needs `@tanstack/react-start` 1.168.10 or later; otherwise `clerk init` prints the manual steps instead.
