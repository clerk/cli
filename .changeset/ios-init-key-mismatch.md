---
"clerk": patch
---

Stop `clerk init` from setting up an existing iOS or macOS app against the linked Clerk application when the app's `Clerk.configure` publishable key belongs to a different application. With `--json` it reports an `input-required` status that names the key's application and the `--relink` command to switch to it, and the result now includes a `configuredKey` field saying whether the key was checked.
