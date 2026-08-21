---
"clerk": patch
---

Stop the "Update available" notice from garbling the "Next steps" block.

The next-steps outro animation moves the cursor back onto the header line for ~450ms, but several commands (`switch-env`, `auth logout`, `unlink`, `users create`, `apps create`, and others) did not await it. The command's promise resolved mid-animation, so the post-command update check printed its notice at the parked cursor position — overwriting the step lines and leaving a stray duplicate "Next steps" header. Every `outro(...)` call is now awaited, so output printed after a command lands below the finished block.
