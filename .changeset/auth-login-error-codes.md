---
"clerk": minor
---

Report why `clerk auth login` failed instead of collapsing every failure into one error.
The browser sign-in wait, OAuth provider errors, state mismatches, missing authorization codes, and callback bind failures now carry distinct error codes, and login records which step of the flow it reached.
