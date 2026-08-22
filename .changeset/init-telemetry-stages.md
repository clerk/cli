---
"clerk": minor
---

Give every failure a specific error code, and record which step a multi-step command reached.
Agent-mode JSON now carries a code for failures that previously reported only a message, and `clerk init` reports the step it stopped at rather than a single generic failure.
