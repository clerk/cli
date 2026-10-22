---
"clerk": patch
---

Wrap the auth header that `clerk init --starter` adds to Next.js App Router layouts in `<Suspense>`, so new apps no longer fail `next build` when Cache Components is enabled, as it is in new `create-next-app` projects.
