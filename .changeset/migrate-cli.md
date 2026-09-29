---
"clerk": minor
---

Add `clerk migrate` for moving users into Clerk. `migrate export <source>` exports users from Clerk, Auth0, Supabase, Auth.js, Better Auth, Firebase or WorkOS into a self-describing file. `migrate import <file|export-run-id>` checks every user against the instance before writing (`--dry-run`, `--allow-partial`), asks before it writes, and continues where a previous run stopped. `migrate runs` shows what every run did, `migrate undo <run-id>` deletes the users an import created, and `migrate sources` shows what each source carries, including sources you write yourself (`--source ./my-source.ts`).
