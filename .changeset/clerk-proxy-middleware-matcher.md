---
"clerk": patch
---

Fix Next.js middleware scaffolding in `clerk init`.

- Include `/__clerk/(.*)` in the generated matcher so Clerk's frontend API proxy routes reach `clerkMiddleware` even when the request path ends in a static-file extension the matcher would otherwise skip.
- Compose into existing middleware that declares its own `export const config` instead of skipping it. Previously any project with a custom matcher was left untouched, so `clerkMiddleware` was never wired in at all. Clerk's matcher replaces the existing one, and the plan now says so before you confirm.
- Remove only the `config` declaration when replacing a matcher. A `config` export placed above the handler previously took the rest of the file with it.
- Leave middleware untouched when its default export is a class or is re-exported from another module. Wrapping those produced a file with two default exports, or one that threw on every request.
