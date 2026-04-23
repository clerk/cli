---
"clerk": patch
---

Document the sandbox limitation in the bundled Clerk skill. AI coding agents that run CLI commands inside a sandbox see false "not signed in" / "no app linked" failures because the OS credential store, `~/.clerk`, linked project metadata, local `.env*` files, and outbound network are unavailable. The skill now tells agents to run Clerk CLI commands on the user's host shell and to discount sandbox-caused auth/linking/env/network failures.
