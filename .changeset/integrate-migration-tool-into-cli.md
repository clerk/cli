---
"clerk": minor
---

Add `clerk migrate` for moving users into Clerk from Clerk, Auth0, Supabase, Auth.js, Better Auth, Firebase or WorkOS.

- `migrate export <source>` writes a self-describing file. `migrate import <file|export-run-id>` checks every user against the instance before writing (`--dry-run`, `--allow-partial`, `--skip-legal-checks`), asks before it writes, and continues where an interrupted or partial run stopped.
- A Firebase import takes the project's hash parameters from the export, the `--firebase-*` flags, or `CLERK_FIREBASE_SIGNER_KEY`, `CLERK_FIREBASE_SALT_SEPARATOR`, `CLERK_FIREBASE_ROUNDS` and `CLERK_FIREBASE_MEM_COST`.
- `migrate import --reserve-unverified` creates the emails and phones a source never verified as reserved (usable for sign-in, locked to the user) instead of unverified. At a terminal, the import asks.
- `migrate runs` shows what every run did, `migrate undo <run-id>` deletes the users an import created, and `migrate sources` shows what each source carries, including sources you write yourself (`--source ./my-source.ts`).
- Every user an import creates carries `clerkMigrateRun` (the run's ID) in its `private_metadata`, replacing any value the source had under that key. A re-run reads it to adopt a user whose create was cut off. Nothing removes it afterwards, and your backend can read it.
- A request that cannot connect now names the host it could not reach.
- `clerk init` warns when the project uses WorkOS, and points to the migration guide.
- Multiselect prompts list `a: all` in their key legend.
- `clerk users` dry runs name the instance the key reaches and where the key came from, such as `--app` or the `CLERK_SECRET_KEY` env var.
