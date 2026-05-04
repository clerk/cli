---
"clerk": minor
---

`clerk init` in agent mode now creates and links a real Clerk application when the user is authenticated, instead of falling back to keyless setup. Keyless still runs in agent mode when the user is not authenticated, but authenticated agent runs leave the project properly linked with real development keys in `.env`.
