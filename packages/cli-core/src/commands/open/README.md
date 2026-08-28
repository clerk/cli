# Open Command

Opens the linked Clerk application's dashboard in your browser. When the current directory isn't linked but holds an unclaimed accountless application instead, opens that application's one-time **claim link** rather than failing.

## Usage

```sh
clerk open                    # Open the linked app's dashboard (development instance)
clerk open users              # Open a known subpath
clerk open api-keys
clerk open --print            # Print the URL instead of opening a browser
```

`open` is Commander's default subcommand for the `open` group — `clerk open [subpath]` and `clerk open dashboard [subpath]` are equivalent.

## Options

| Option    | Description                                                                  |
| --------- | ---------------------------------------------------------------------------- |
| `--print` | Print the URL on stdout; don't open a browser or a browser fallback message. |

## Behavior

1. Resolves the linked profile for the current directory (`resolveProfile(cwd)` from [`lib/config.ts`](../../lib/config.ts)).
2. **Linked** — builds `{dashboardUrl}/apps/{appId}/instances/{instanceId}/{subpath?}` via `buildDashboardUrl()` and opens it. Always targets the **development** instance; throws `INSTANCE_NOT_FOUND` if the profile has none.
3. **Not linked** — falls through to the accountless path below instead of failing outright.

An unknown `subpath` (not in [`dashboard-paths.ts`](./dashboard-paths.ts)'s allowlist) is not blocked, just warned about — the CLI opens it anyway since the allowlist can't keep up with every dashboard route.

### Unclaimed accountless applications

`clerk link` cannot help an accountless application that has never been claimed — there is no application in any account yet to link to. For that case `open` instead looks for the application's **claim link**, via [`keyless-claim.ts`](./keyless-claim.ts), checking (in order):

1. `.clerk/.tmp/keyless.json` — an SDK that self-provisioned keys (e.g. `next dev` with none configured) writes its own full `claimUrl` here.
2. `.clerk/keyless.json` — the legacy-named breadcrumb `clerk init --accountless` writes (see [`lib/keyless.ts`](../../lib/keyless.ts)'s `readKeylessBreadcrumb`), holding just the claim token; the URL is rebuilt as `{dashboardUrl}/apps/claim?token={claimToken}`.

If a claim link is found, `open` opens/prints/emits **that** URL instead of a dashboard deep-link — an unclaimed app has no `/apps/{appId}/instances/{instanceId}` page to go to. The local secret key (resolved the same way as [`whoami`](../whoami/README.md), via the legacy-named `resolveKeylessTarget()`) is used, best-effort, to look up the instance id/environment type from `GET /v1/instance` purely to decorate the output; a missing or invalid key there never blocks opening the claim link itself.

A `subpath` cannot be honored for an unclaimed application (there is no dashboard page beyond the claim link yet), so `open users` on an unclaimed app throws instead of silently opening the claim link at the wrong URL:

```text
"users" isn't reachable yet — this application hasn't been claimed, so it has
no dashboard pages beyond the claim link. Run `clerk open` (no subpath) to
claim it, then retry the subpath once it's linked.
```

When **no** claim link can be found at all, the error differs depending on what is on disk, and deliberately does not send the user solely to `clerk link` (a dead end for a genuinely unclaimed app):

- A secret key exists locally but no claim source does (e.g. `CLERK_SECRET_KEY` set by hand with no `.clerk` files) — names both possibilities: the key may belong to an already-claimed app (`clerk link` / `--app <app_id>`) or the claim breadcrumb was lost (`clerk init --accountless` regenerates one).
- Nothing at all is found — the original message, pointing at both `clerk link` (if an application already exists in your account) and `clerk init` (to create one).

| Method | Endpoint       | Description                                                                                                                              |
| ------ | -------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `GET`  | `/v1/instance` | Best-effort instance id/environment lookup for display, authenticated with the local secret key. Never blocks the claim link on failure. |

## Output modes

- **`--print`** — the bare URL on stdout, nothing else. Works identically for the dashboard deep-link and the accountless claim link.
- **Agent mode** (`isAgent()`) — a JSON object on stdout, `opened: false` either way:
  - Linked: `{ url, appId, appName, instanceId, instanceLabel, subpath, opened }`.
  - Accountless: `{ url, accountless: true, keyless: true, claimSource, instanceId, environmentType, subpath: null, opened: false }` — `keyless` is a deprecated alias of `accountless`, kept for agents that still parse the legacy key (same treatment as `whoami`'s JSON output).
- **Human mode** — `intro`/`outro` framing, the target app or claim-link context on stderr, then attempts `openBrowser()`. On failure, prints the URL as a fallback instead of failing the command.
