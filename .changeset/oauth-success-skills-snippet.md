---
"clerk": minor
---

Promote Clerk Skills on the OAuth success page. After `clerk auth login` redirects back to the local callback, the success page now shows an installer panel with `npx skills add clerk/skills`, a copy button, and a link to `clerk.com/docs/guides/ai/overview`. Page styling moved to CSS custom properties with `prefers-color-scheme` overrides and `color-scheme: light dark` for native form theming. UTF-8 charset is now declared in the response header and meta tag.
