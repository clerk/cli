---
"clerk": patch
---

Mark `clerk migrate`'s Backend API requests with a `migrate` segment in the `User-Agent`, so Clerk can count the users each migration creates. Like usage telemetry, the CLI leaves it out when telemetry is off.
