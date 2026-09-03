---
"clerk": patch
---

`clerk auth login` now explains why a keyless application could not be claimed when the active workspace is managed by an integration such as Vercel Marketplace or Stripe. When the Platform API rejects the claim with the error code `accountless_application_managed_workspace`, the CLI prints "Unable to claim - this workspace is managed by Vercel. Switch to a workspace you own in the Clerk Dashboard, then run `clerk auth login` again." instead of the generic "no active organization" warning, and keeps the local claim token so the next `clerk auth login` from a workspace you own claims the application.
