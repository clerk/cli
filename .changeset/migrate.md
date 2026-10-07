---
"clerk": minor
---

Make `clerk migrate` available without `CLERK_EXPERIMENTAL=migrate`: it now shows in `clerk --help` and shell completion.

- `clerk migrate export` gets users out of Clerk, Supabase, Firebase, Auth0, WorkOS, Better Auth or Auth.js into a run, and `clerk migrate import` checks every user against your instance, asks before it writes, and continues a run that stopped partway.
- `clerk migrate runs` shows what each run did, `clerk migrate undo` deletes the users an import created, and `clerk migrate sources` shows what each source brings across. `--source ./my-source.ts` imports with a source you wrote.
- `clerk migrate import --reserve-unverified` creates the emails and phones a source never verified as reserved (usable for sign-in, locked to the user) instead of unverified. At a terminal, the import asks.
