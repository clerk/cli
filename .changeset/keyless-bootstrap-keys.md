---
"clerk": minor
---

Delegate keyless mode to the SDK during `clerk init` instead of writing temporary keys. When an authenticated user runs `clerk init` with an existing SDK keyless breadcrumb, automatically claim the app and pull real keys in one step.
