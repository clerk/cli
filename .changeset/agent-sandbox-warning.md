---
"clerk": patch
---

Improve Clerk CLI behavior for sandboxed agent runs.

The CLI now warns once per invocation when host-only Clerk state or system
capabilities are unavailable in agent mode, which helps distinguish real auth
and linking failures from sandbox-induced ones. `clerk doctor` also includes a
`Host execution` check in agent mode so the sandbox condition is visible in
structured diagnostics.

This release also updates the bundled Clerk skill docs to explain the warning,
when to rerun commands on the host, and how sandboxed agent runs can misreport
auth, linking, env, and API failures.
