---
"clerk": patch
---

Stop a failing interrupt sequence from printing an unhandled rejection on Ctrl-C.

The SIGINT handler is async so it can await the telemetry flush that reports the interrupted run, but it was registered directly with `process.on`, which discards a listener's return value. If anything in that sequence rejected — the lazy telemetry import, the flush itself — the failure surfaced as an unhandled rejection stack trace at the exact moment the user was trying to get their shell back, and the process never reached the signal death that a wrapping script reads. The registered listener is now a synchronous wrapper that exits by the route the interrupt calls for even when the sequence fails.
