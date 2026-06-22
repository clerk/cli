---
"clerk": patch
---

Add a default 60s timeout to all outbound CLI network requests. Previously a stalled connection to a Clerk API could hang a command indefinitely (with no error and no way to recover other than Ctrl-C); requests now abort with a clear, tagged error after 60s. A caller-supplied `AbortSignal` still composes with this default, so tighter per-call budgets continue to win.
