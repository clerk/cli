---
"clerk": patch
---

Mark the requests `clerk migrate` sends with a `migrate` segment in the `User-Agent`, so Clerk can count the users each migration creates. Like usage telemetry, the CLI leaves it out when telemetry is off.
