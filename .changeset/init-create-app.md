---
"clerk": minor
---

Agents can let `clerk init --create-app` create the Clerk application for an iOS or macOS app, instead of running `clerk apps create` first. The application is created only after everything that could stop setup has passed (sign-in, the new app's name and folder, the Xcode target, deployment target, signing team, and native identity, and the link check), so a stopped run never leaves an unused application behind. If setup stops after it's created, the error and JSON status name it and the `--app` command that reuses it.
