---
"clerk": patch
---

`clerk logs list` now dates both ends of the searched range when either isn't today, so a range that crosses midnight no longer reads like a few minutes, and the retention warning says "1 day" instead of "1 days".
