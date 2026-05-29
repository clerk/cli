---
"clerk": minor
---

Add `clerk deploy status`, a read-only command that verifies a production deploy, including DNS, SSL, email DNS, and OAuth credential completeness. Agent-mode `clerk deploy` now emits a tailored read-only handoff instead of a hard usage error.
