---
"clerk": patch
---

Fix link saving to wrong directory during bootstrap flow. When creating a new project via `clerk init`, the Clerk application link is now correctly saved to the new project directory instead of the parent directory.
