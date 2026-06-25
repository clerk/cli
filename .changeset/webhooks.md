---
"clerk": minor
---

Add the `clerk webhooks` command group for managing webhook endpoints and deliveries from the terminal: `list`, `get`, `create`, `update`, `delete`, `secret [--rotate]`, `event-types`, `messages`, `replay`, `listen`, `trigger`, `verify`, and `open`.

`webhooks listen` supports `--relay-only` to run the local relay tunnel with no Clerk backend (no PLAPI, no auth), and `--token <c_…>` to pin a stable, shareable relay URL. The relay token is persisted per instance, so the relay URL stays the same across restarts.
