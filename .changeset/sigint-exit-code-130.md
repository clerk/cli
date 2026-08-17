---
"clerk": patch
---

Fix the exit code when a command is interrupted with Ctrl-C. Interrupting an in-flight operation now exits 130 by terminating on SIGINT, so wrapping shell scripts stop as expected; Ctrl-C while the CLI is only waiting — at a prompt, during a countdown, or for browser sign-in — still exits 0. Interrupted runs are also reported to telemetry instead of going unrecorded.
