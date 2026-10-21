---
"clerk": patch
---

Wrap the sign-in and sign-up pages that `clerk init` creates for Next.js App Router apps in `<Suspense>`, so `next build` succeeds when Cache Components is enabled, as it is in new `create-next-app` projects.
