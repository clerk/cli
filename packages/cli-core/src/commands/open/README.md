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

An application in no account yet has no Dashboard page of its own, so `open` looks for its one-time **claim link**, via [`keyless-claim.ts`](./keyless-claim.ts), in the order the unlinked-folder classifier ranks what a folder holds:

1. `.clerk/keyless.json` — the legacy-named breadcrumb `clerk init --accountless` writes (see [`lib/keyless.ts`](../../lib/keyless.ts)'s `readKeylessBreadcrumb`), holding just the claim token; the URL is rebuilt as `{dashboardUrl}/apps/claim?token={claimToken}`. `clerk link` and `clerk auth login` claim this app first too.
2. `.clerk/.tmp/keyless.json` — an SDK that self-provisioned keys (e.g. `next dev` with none configured) writes its own full `claimUrl` here. Used only when the folder holds no plain key (one that's there is the app the folder runs on), and only an https link to the Clerk Dashboard, re-serialized before it reaches the browser launcher.

If a claim link is found, `open` opens/prints/emits **that** URL instead of a dashboard deep-link — an unclaimed app has no `/apps/{appId}/instances/{instanceId}` page to go to. The local secret key (resolved the same way as [`whoami`](../whoami/README.md), via the legacy-named `resolveKeylessTarget()`) is used, best-effort, to look up the instance id/environment type from `GET /v1/instance` purely to decorate the output; a missing or invalid key there never blocks opening the claim link itself.

A `subpath` cannot be honored for an unclaimed application (there is no dashboard page beyond the claim link yet), so `open users` on an unclaimed app fails with `not_linked` instead of silently opening the claim link at the wrong URL. The message is the step for what the folder holds, from [`lib/unlinked-folder.ts`](../../lib/unlinked-folder.ts), then the command again. For a person in a folder `clerk init` created signed out:

```text
"users" isn't reachable yet — this application hasn't been claimed, so it has
no dashboard pages beyond the claim link. This folder's app was created by
`clerk init` and isn't in an account yet. Run `clerk link`: it claims the app
into your account and links this folder. Then run `clerk open users` again.
```

An agent gets the step for its credential: `clerk link` or `clerk auth login` claims an init app, and for an SDK-created app a person runs `clerk open` in their own terminal, in the project's folder. In agent mode the commands come as `examples`, never including `clerk open`: run by an agent, it prints the claim link, which carries a claim token.

When **no** claim link can be found at all, `open` fails with `not_linked`. The lead depends on whether a secret key is on disk, and the advice after it is the step for what the folder holds, from [`lib/unlinked-folder.ts`](../../lib/unlinked-folder.ts), as every not-linked message gives (in agent mode, its commands come as `examples`):

- A secret key exists locally but no claim source does (e.g. Dashboard keys pasted into `.env`) — "Found a secret key (from `<source>`) but no claim link on disk, and this folder isn't linked, so there's no dashboard page to open." For an app in no account yet (an init app, or an SDK app whose claim link works), it ends "so there's no dashboard page to open yet." instead. For plain keys the step is `clerk link`, which finds the app in your account by the publishable key. It never suggests `clerk init --accountless`: that creates a new app and overwrites the folder's keys.
- Nothing at all is found — "No Clerk project linked to this directory, and no accountless application was found either.", then `clerk link` to choose one of your apps, or `clerk init` to create one.

| Method | Endpoint       | Description                                                                                                                              |
| ------ | -------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `GET`  | `/v1/instance` | Best-effort instance id/environment lookup for display, authenticated with the local secret key. Never blocks the claim link on failure. |

## Output modes

- **`--print`** — the bare URL on stdout, nothing else. Works identically for the dashboard deep-link and the accountless claim link.
- **Agent mode** (`isAgent()`) — a JSON object on stdout, `opened: false` either way:
  - Linked: `{ url, appId, appName, instanceId, instanceLabel, subpath, opened }`.
  - Accountless: `{ url, accountless: true, keyless: true, claimSource, instanceId, environmentType, subpath: null, opened: false }` — `keyless` is a deprecated alias of `accountless`, kept for agents that still parse the legacy key (same treatment as `whoami`'s JSON output).
- **Human mode** — `intro`/`outro` framing, the target app or claim-link context on stderr, then attempts `openBrowser()`. On failure, prints the URL as a fallback instead of failing the command.
