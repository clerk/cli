---
"clerk": patch
---

Fix `clerk enable orgs --auto-create` so organizations are actually auto-created for new users. The flag now also enables organization creation defaults, which the API requires before honoring the automatic creation setting.
