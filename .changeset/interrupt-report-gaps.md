---
"clerk": patch
---

Report what was established when Ctrl-C interrupts `clerk deploy status`, and record interrupted runs in usage telemetry.

- `clerk deploy status` no longer exits silently when the interrupt arrives before the deploy state is read. Agent mode emits a report with `state: "interrupted"`, which asserts nothing about the deploy.
- An interrupted command now sends its `abort` outcome instead of no event at all.
