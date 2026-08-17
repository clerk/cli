---
"clerk": patch
---

Fix the exit code when a command is interrupted with Ctrl-C. Interrupting an operation — an in-flight request, or a project generator run by `clerk init` — now exits 130 by terminating on SIGINT, so wrapping shell scripts stop as expected, and the interrupted run is reported to telemetry instead of going unrecorded. Ctrl-C while the CLI is only waiting, at a prompt or during a countdown, still exits 0.
