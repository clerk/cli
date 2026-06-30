---
"clerk": minor
---

Add the `clerk webhooks` command group (V1): a PLAPI-free local webhooks toolkit.

- `clerk webhooks listen` — open a standalone Svix relay tunnel and forward deliveries to a local handler. No auth, no linked project, no backend. `--forward-to` is required. Without `--token`, the banner warns that the auto-generated relay token isn't a guaranteed-stable handle and prints the exact `--token` to pin next time; `--token <c_…>` pins an explicit, shareable URL. Flags: `--forward-to` (required), `--token`, `--headers`, `--json`. When `--forward-to` is missing, the usage error prints a runnable example beneath it.
- `clerk webhooks verify` — verify a webhook signature offline (HMAC-SHA256), from a saved `listen` event line (`--delivery`) or the four explicit header values. No network calls.
- `clerk webhooks token` — generate a valid relay token (`c_` + 10 base62 chars) for `listen --token`. Prints the bare token to stdout so it pipes: `clerk webhooks listen --token "$(clerk webhooks token)"`.
