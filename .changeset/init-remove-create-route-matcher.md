---
"clerk": patch
---

Stop scaffolding deprecated `createRouteMatcher` route protection in Next.js middleware during `clerk init` — generate bare `clerkMiddleware()` and point to resource-level protection with `auth.protect()` instead.
