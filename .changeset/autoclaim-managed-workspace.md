---
"clerk": patch
---

`clerk auth login` now explains why a keyless application could not be claimed when the active workspace is managed by an integration such as Vercel Marketplace or Stripe. When the Platform API rejects the claim with the error code `accountless_application_managed_workspace`, the CLI prints the API message, for example "Unable to claim - The target application cannot be claimed into the current workspace. Select a different workspace and try again.", instead of the generic "no active organization" warning, and keeps the local claim token so the next `clerk auth login` from a workspace you own claims the application.
