---
"clerk": minor
---

Add `clerk deploy check`, a read-only command that verifies a production deploy, including DNS, SSL, mail, and OAuth credential completeness. Agent-mode `clerk deploy` now emits a tailored read-only handoff instead of a hard usage error.
