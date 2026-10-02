---
"clerk": minor
---

Add `clerk migrate` for moving users into Clerk from Clerk, Auth0, Supabase, Auth.js, Better Auth, Firebase or WorkOS.

- `migrate export <source>` writes a self-describing file. `migrate import <file|export-run-id>` checks every user against the instance before writing (`--dry-run`, `--allow-partial`, `--skip-legal-checks`), asks before it writes, and continues where an interrupted or partial run stopped.
- `migrate runs` shows what every run did, `migrate undo <run-id>` deletes the users an import created, and `migrate sources` shows what each source carries, including sources you write yourself (`--source ./my-source.ts`).
- A request that cannot connect now names the host it could not reach.
- `clerk init` warns when the project uses WorkOS, and points to the migration guide.
- Multiselect prompts list `a: all` in their key legend.
- `clerk users` dry runs name the instance the key reaches and where the key came from, such as `--app` or the `CLERK_SECRET_KEY` env var.
