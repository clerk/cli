---
"clerk": patch
---

Teach agents the `+clerk_test` email suffix and the US fictional-phone range (`+1 (XXX) 555-0100` through `+1 (XXX) 555-0199`), paired with the fixed `424242` OTP, for creating test users that bypass client trust in development. The pattern is documented in the bundled skill's recipes and every `clerk init --prompt` handoff.
