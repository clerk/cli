# Keyless demos

Recorded walkthroughs of what the CLI can do against an **unclaimed keyless
application** — a Clerk app created anonymously, with no account, no login, and
no browser round-trip.

Each tape is a script of exactly what is shown. Re-record them with:

```sh
./docs/keyless-demos/record.sh          # every tape
./docs/keyless-demos/record.sh 03 06    # just these
```

Requires [VHS](https://github.com/charmbracelet/vhs) (`brew install vhs`).

## How they run

`clerk` on the tapes' `PATH` is a shim that runs this working tree, so a
recording always shows _this checkout_ rather than a globally installed CLI.

It runs the TypeScript entry point rather than the `build:compile` binary on
purpose: a locally built binary is unsigned, so macOS raises a keychain
authorization dialog the first time it reads the credential store — which a
headless recording can never answer, and the tape hangs. The shim passes
`--env-file=/dev/null` so Bun's `.env` autoload stays out of the way and the CLI
resolves keys from the project's files itself, exactly as the signed release
binary does. Without it, every key would be reported as coming from an
environment variable rather than from `.env.local`.

Every tape mints its own keyless application against the real Clerk API through
the public `POST /v1/accountless_applications` endpoint — the same one
`clerk init --keyless` uses. Nothing needs cleaning up afterwards: unclaimed
applications are throwaway by construction.

### The `[KEYLESS-DEMO]` banner

These demos are about a developer who has never logged in, recorded on a machine
that has. `signed_out()` in `lib/demo-env.sh` points the CLI at an empty config
directory and at an environment named `keyless-demo`. Sessions are keyed
`oauth-access-token:<environment>` in the OS keyring, so that name alone misses
every stored credential without reading, touching, or deleting any of them — and
the CLI prints its non-production banner as a result.

It is only the credential store that is isolated. Both environment profiles hold
the real Clerk URLs: every request in every recording goes to `api.clerk.com`
against a genuine application.

Only publishable keys and instance IDs ever reach the screen. Secret keys go
straight into `.env.local`, which no tape prints. If you add a tape, keep it
that way.

## The tapes

| Tape                       | What it shows                                                                               |
| -------------------------- | ------------------------------------------------------------------------------------------- |
| `01-bootstrap.tape`        | `clerk init --keyless` on a signed-out machine, then `clerk whoami` naming the new instance |
| `02-read-config.tape`      | `clerk config pull`, whole and by `--keys`, authenticated only by the local secret key      |
| `03-change-config.tape`    | `clerk config patch` — dry run, apply, read back, multi-group payload                       |
| `04-toggles.tape`          | `clerk enable orgs` / `clerk disable orgs`, including the idempotent second run             |
| `05-templates.tape`        | `clerk init --template b2b-saas`, which returns an app with organizations already on        |
| `06-guardrails.tape`       | The refusals: `config put`, an account-only config key, `--instance`, `enable billing`      |
| `07-agent-mode.tape`       | The same application driven by `--mode agent`, where every answer is JSON                   |
| `08-sso-connections.tape`  | Adding and removing an enterprise SSO connection, which needs no account                    |
| `09-health-and-users.tape` | `clerk doctor`, `clerk users list` and `clerk open --print` on a keyless project            |

## Layout

```
docs/keyless-demos/
├── record.sh          # write the `clerk` shim, then run the tapes
├── lib/demo-env.sh    # sourced by each tape inside a Hide block
├── tapes/             # one tape per workflow; _common.tape holds the shared look
├── bin/               # the `clerk` shim under test  (gitignored)
└── out/               # rendered gif + mp4           (gitignored)
```

The throwaway projects the tapes build go under `$TMPDIR/clerk-keyless-demos`,
outside the repository. Inside a dirty git worktree, `clerk init` opens by
telling you to commit first — correct advice, and pure noise in a recording
about something else.
