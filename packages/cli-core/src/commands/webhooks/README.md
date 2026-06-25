# `clerk webhooks` (V1)

The PLAPI-free slice of the webhooks toolkit: a local relay tunnel plus offline
signature verification. Neither subcommand calls the Clerk API, requires auth, or
needs a linked project.

> **No Clerk API calls.** `listen` talks only to the Svix relay
> (`wss://api.relay.svix.com`); `verify` is pure local HMAC. There is no
> PLAPI/BAPI dependency in this command group.

## The flow

```sh
clerk webhooks token                                                   # 1. mint a stable token
clerk webhooks listen --token "$(clerk webhooks token)" --forward-to … # 2. stream to your app
clerk webhooks verify --secret whsec_... --delivery @event.json        # 3. verify a delivery
```

## `clerk webhooks token`

Generate a valid relay token (`c_` + 10 base62 chars) for `listen --token`. The
bare token prints to **stdout** so it pipes cleanly; human mode adds a usage hint
on stderr (which never pollutes the pipe).

```sh
clerk webhooks token                                  # → c_AbCd123456
clerk webhooks listen --token "$(clerk webhooks token)"   # generate + pin in one step
clerk webhooks token --json                           # → {"token":"c_AbCd123456"}
```

Why it exists: the `--token` format is exact (`c_` + **10** base62 chars), so this
removes the guesswork of hand-writing one.

## `clerk webhooks listen`

Open a standalone Svix relay tunnel, print a stable inbox URL, and forward each
delivery to a local handler.

```sh
clerk webhooks listen --forward-to http://localhost:3000/api/webhooks
```

| Option               | Description                                                                                                           |
| -------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `--forward-to <url>` | **Required.** Local URL to POST deliveries to.                                                                        |
| `--token <c_token>`  | Pin the relay token so the inbox URL stays fixed across machines. `c_` + 10 base62 chars (gen with `webhooks token`). |
| `--headers <pairs>`  | Extra headers for the forwarded request, comma-separated `k:v` pairs. `svix-*` headers can't be overridden.           |
| `--json`             | Emit NDJSON: one `ready` line then one `event` line per delivery (pipe into a file for `webhooks verify --delivery`). |

**Pin your URL.** Without `--token`, the relay token is generated for you and
persisted locally — but it isn't a guaranteed-stable handle (it can differ on a
new machine, a cleared config, or a rare token collision). When you run `listen`
**without** `--token`, the banner warns you and prints the exact `--token` to pass
next time. For a fixed, shareable URL, always pin it:

```sh
clerk webhooks listen --token "$(clerk webhooks token)" --forward-to http://localhost:3000/api/webhooks
```

**No verification.** Without the backend there is no per-endpoint signing secret,
so deliveries are forwarded as-is. The original `svix-*` headers are preserved on
the forwarded request, so your handler can still verify against the signing secret
of the dashboard endpoint you point at the inbox URL.

**Ready line schema (`--json`):**
`{ "type": "ready", "relay_url", "forward_to" }` — emitted once, then one
`event` line per delivery (and a `{ "type": "reconnecting" }` line if the relay
connection drops).

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
