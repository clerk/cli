---
"clerk": patch
---

Stop `clerk init` from setting up an existing iOS or macOS app against the linked Clerk application when the app's `Clerk.configure` publishable key belongs to a different application. With `--json` it reports an `input-required` status that names each mismatched configuration and the key's application, with the `--relink` command when relinking would fix every configuration, and the result now includes a `configuredKeys` field saying, for each configuration, whether its key was checked.
