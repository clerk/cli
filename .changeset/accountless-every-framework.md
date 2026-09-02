---
"clerk": minor
---

Let `clerk init` set up an accountless application on every framework it supports. Vue, React, JavaScript, Expo, Express, Fastify, iOS, and Android now resolve to accountless the same way Next.js does: unauthenticated agent runs and new-project bootstraps mint temporary development keys without a login, `--accountless` is accepted everywhere, and the agent-mode "set up keys manually" fallback is gone. iOS and Android projects get only the publishable key in `.env`, since their default `.gitignore` doesn't cover it.
