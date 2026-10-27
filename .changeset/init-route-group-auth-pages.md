---
"clerk": patch
---

Skip creating sign-in and sign-up pages in `clerk init` for Next.js App Router apps that already have them inside a route group, such as `app/(marketing)/sign-in/[[...sign-in]]/page.tsx`, instead of adding a second page for the same URL.
