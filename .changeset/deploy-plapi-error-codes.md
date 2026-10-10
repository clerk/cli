---
"clerk": patch
---

Fix `clerk deploy` showing a raw "Request failed" error when the application already has a production instance or the domain is in use by another application. The wizard now resumes the existing production instance, and a taken domain gets a message that says to pick a different one.
