---
"clerk": minor
---

Add `clerk security`, a security audit for a Clerk instance. `clerk security audit` grades the instance against 19 recommendations (bot protection, breached-password detection, brute-force lockout, device trust, MFA, session limits, sign-up restrictions, and more), and prints a report grouped by severity. In agent mode or with `--json` every finding carries the exact `clerk config patch` payload that closes it. `clerk security fix <ids...>` applies the patches as one config patch with a diff, a confirmation, and server-side `--dry-run`, then reports the new grade and the remaining gaps. Bare `clerk security fix` opens a checklist; `--all` applies every critical and recommended gap, with `--good-to-have` opting into the rest. Checks that need a product decision, such as which second factors to offer, ask interactively or take `--factors` / `--strategy` from agents. `clerk security checks` lists the catalog offline.
