---
"clerk": minor
---

Add the `clerk webhooks` command group (V1): a PLAPI-free local webhooks toolkit.

- `clerk webhooks listen` — open a standalone Svix relay tunnel and forward deliveries to a local handler. No auth, no linked project, no backend. The relay token is persisted so the inbox URL is stable across restarts; `--token <c_…>` pins an explicit, shareable URL. Flags: `--forward-to`, `--token`, `--headers`, `--json`.
- `clerk webhooks verify` — verify a webhook signature offline (HMAC-SHA256), from a saved `listen` event line (`--delivery`) or the four explicit header values. No network calls.
