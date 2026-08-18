---
"clerk": patch
---

Fix the exit code when a command is interrupted with Ctrl-C. Interrupting a command now exits 130 by terminating on SIGINT rather than calling `process.exit(130)`, so a wrapping shell script sees a real signal death and stops as expected, and the interrupted run is reported to telemetry instead of going unrecorded. This covers in-flight requests, poll intervals and retry backoffs, project generators run by `clerk init`, and `clerk webhooks listen` once it has drained. Ctrl-C while the CLI is only waiting on you — at a prompt, during browser sign-in, or in `$EDITOR` — still exits 0.
