# `clerk webhooks` (V1)

The PLAPI-free slice of the webhooks toolkit: a local relay tunnel plus offline
signature verification. Neither subcommand calls the Clerk API, requires auth, or
needs a linked project.

> **No Clerk API calls.** `listen` talks only to the Svix relay
> (`wss://api.relay.svix.com`); `verify` is pure local HMAC. There is no
> PLAPI/BAPI dependency in this command group.

## `clerk webhooks listen`

Open a standalone Svix relay tunnel, print a stable inbox URL, and (optionally)
forward each delivery to a local handler.

```sh
clerk webhooks listen --forward-to http://localhost:3000/api/webhooks
```

| Option               | Description                                                                                                           |
| -------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `--forward-to <url>` | Local URL to POST deliveries to. Omit to just print events.                                                           |
| `--token <c_token>`  | Pin the relay token so the inbox URL stays fixed across restarts. Format: `c_` + 10 base62 chars.                     |
| `--headers <pairs>`  | Extra headers for the forwarded request, comma-separated `k:v` pairs. `svix-*` headers can't be overridden.           |
| `--json`             | Emit NDJSON: one `ready` line then one `event` line per delivery (pipe into a file for `webhooks verify --delivery`). |

**Stable URL.** The relay token is persisted in the CLI config under
`relay.__relay_only__`, so the inbox URL survives restarts — register it once in
your Svix/Clerk dashboard and keep reusing it. `--token` pins an explicit one.

**No verification.** Without the backend there is no per-endpoint signing secret,
so deliveries are forwarded as-is. The original `svix-*` headers are preserved on
the forwarded request, so your handler can still verify against the signing secret
of the dashboard endpoint you point at the inbox URL.

**Ready line schema (`--json`):**
`{ "type": "ready", "relay_url", "endpoint_id": null, "events_filter": null, "forward_to" }`
— `endpoint_id`/`events_filter` are always `null` in V1 (no registered endpoint).

## `clerk webhooks verify`

Verify a Svix webhook signature locally — HMAC-SHA256 over
`{id}.{timestamp}.{payload}`, constant-time matched against every `v1,<base64>`
entry in the header (any match wins, covering the 24h rotation grace window).

```sh
# From a saved `listen` event line:
clerk webhooks verify --secret whsec_... --delivery @event.json

# From the four explicit header values:
clerk webhooks verify --secret whsec_... --payload @body.json \
  --id msg_2xyz --timestamp 1717935000 --signature v1,abc...
```

`--secret` is always required. `--payload`/`--delivery` take `@file` or `-` for
stdin (inline values get mangled by shells). Explicit flags override `--delivery`
fields.
