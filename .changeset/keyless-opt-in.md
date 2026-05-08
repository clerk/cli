---
"clerk": minor
---

Make keyless mode opt-in via a new `--keyless` flag on `clerk init`. Previously, `clerk init` on a keyless-capable framework (Next.js, Astro, Nuxt, TanStack Start, React Router) would silently fall back to auto-generated temporary dev keys whenever the user wasn't authenticated. The default now triggers `clerk auth login` and links a real Clerk application.

- `clerk init` (default): authenticates and links a real app.
- `clerk init --keyless`: scaffolds with auto-generated dev keys; the user can run `clerk auth login` later to claim the temporary application.
- `clerk init --keyless` on a non-keyless framework exits with a usage error rather than silently ignoring the flag.
- `clerk init -y` no longer bypasses authentication. `-y` only skips y/n confirmation prompts; without `--keyless`, an unauthenticated user is still prompted to log in via the browser.
- Agent-mode `clerk init` without authentication and without `--keyless` (or `--app`) prints manual setup guidance instead of generating dev keys, since agents cannot run interactive OAuth.
