# `clerk migrate`

Migrate users into a Clerk instance from another auth provider, or from another
Clerk instance.

## Targeting And Auth

`clerk migrate import` resolves its Backend API key through the CLI's standard
chain:

| Flag                 | Description                                                   |
| -------------------- | ------------------------------------------------------------- |
| `--secret-key <key>` | Use a specific Backend API secret key directly                |
| `--app <id>`         | Target an application directly, even outside a linked project |
| `--instance <id>`    | Target `dev`, `prod`, or a full instance ID                   |

Resolution order: `--secret-key` → `--app` + Platform API lookup →
`CLERK_SECRET_KEY` → the keyless project's own key → a linked project profile
from `clerk link`.

The **instance type is read from the key**: `sk_live_…` is treated as
production, anything else as development. That choice drives the throughput
defaults and the hard development-instance cap below.

## Commands

`clerk migrate` on its own is a group name, not a command: it prints its help
and lists the subcommands below. The direction is always spelled out —
`migrate import` moves users **into** Clerk, `migrate export` gets them **out**
of a source platform — so neither is implied by the group.

### `clerk migrate import` (interactive)

Bare `clerk migrate import` walks a human through the import instead of
demanding flags.

```sh
clerk migrate import
```

It picks the source from a list built off the registry, asks for the file,
and collects Firebase's hash parameters when they are needed. Anything already
passed as a flag is not asked for.

Then it prints the [Migration Readiness report](#migration-readiness-report),
offers to [change whatever it flagged](#changing-the-flagged-settings), and
waits for confirmation. Declining writes nothing to Clerk.

**Agent mode never prompts.** `clerk migrate import` with no flags exits with a
usage error naming exactly what to pass:

```
`clerk migrate import` is interactive and cannot prompt in agent mode.
Pass the file (or an export run ID) and --source <platform>.
```

### `clerk migrate import`

Reads an exported user file, maps it onto Clerk's user schema, validates every
record, and creates the users through the Backend API.

```sh
clerk migrate import 20260929-141502-a1b2 -y        # an export run
clerk migrate import users.json --source clerk -y
```

| Flag                                    | Description                                                      |
| --------------------------------------- | ---------------------------------------------------------------- |
| `[file\|export-run-id]`                 | The export file, or the ID of the export run that wrote it       |
| `--source <key\|path>`                  | Where the file came from: a [source](#sources), or one you wrote |
| `-f, --file <path>`                     | Path to the export. `.json` or `.csv`                            |
| `-r, --resume-after <user-id>`          | Skip every user up to and including this **source** ID           |
| `--require-password`                    | Import only users that carry a password digest                   |
| `--skip-unsupported-providers`          | Supabase: skip users whose only social provider is off in Clerk  |
| `--firebase-signer-key <key>`           | Firebase base64 signer key                                       |
| `--firebase-salt-separator <separator>` | Firebase base64 salt separator                                   |
| `--firebase-rounds <n>`                 | Firebase scrypt rounds                                           |
| `--firebase-mem-cost <n>`               | Firebase scrypt memory cost                                      |
| `-y, --yes`                             | Skip the confirmation prompt                                     |
| `--runs-dir <path>`                     | Where runs are kept (see [Runs](#clerk-migrate-runs))            |

Plus the targeting flags from the table above: `--secret-key`, `--app` and
`--instance`.

The file is the positional argument or `--file`, not both. An export run ID
stands for the file that run wrote, and the import records it as `fromExport`.

A file `clerk migrate export` wrote carries its source, so it needs no
`--source`. A `--source` that contradicts it exits 2. Any other file
— a bare JSON array, a CSV, Firebase's own `{ "users": [...] }` — needs
`--source`, and omitting it fails with a usage error that names the valid
values.

Failures do not stop the run: each user's outcome is written to the
[run](#clerk-migrate-runs) and the import continues. A `429` backs off — honouring `Retry-After` when the response
carries it — and retries up to 5 times before the user is recorded as failed.
The command exits non-zero if any user failed.

Two failures do abort the whole run, because continuing would produce a
corrupt instance:

- An **unrecognized password hasher**, which would import credentials nobody can
  sign in with.
- A **`--resume-after` ID that is not in the file**, which would otherwise
  re-import every user the previous run already created.

#### Additional identifiers

Only the first verified email and phone go on `POST /v1/users`. Every
additional verified identifier, and every unverified one, is attached
afterwards with its own request. A failure there is logged and the user still
counts as imported — a duplicate secondary email should not undo an otherwise
successful user.

#### Throughput

Defaults follow Clerk's documented `POST /v1/users` limits: 100 req/s for
production instances, 10 req/s for development. Concurrency defaults to ~95% of
that, assuming ~100ms of API latency. Both are overridable:

| Variable                          | Effect                        |
| --------------------------------- | ----------------------------- |
| `CLERK_MIGRATE_RATE_LIMIT`        | Requests per second           |
| `CLERK_MIGRATE_CONCURRENCY_LIMIT` | Concurrent in-flight requests |

A non-numeric or non-positive value is ignored in favour of the default.

**Development instances warn when an import may exceed their user limit.** New
development instances are created with a 100-user limit; production instances
have none. Before importing, the run reads the instance's current user count
(`GET /v1/users/count`) and warns when the file would take it past 100.

The run then stops and asks before going ahead. It is a prompt rather than a
hard refusal because the number checked against may not be this instance's:
Clerk raises a development instance's limit on request, and the raised value
(`max_allowed_users`) is not served by BAPI, DAPI or FAPI — so the CLI can show
the live count but never the live limit. Declining aborts before anything is
written to Clerk; `-y` and agent mode proceed on the warning alone.

Users that do exceed the limit come back in the error breakdown as
`You have reached your limit of N users`, annotated with what a development
instance can do about it.

### `clerk migrate export`

Gets users **out** of a source platform, so there is something to feed
`clerk migrate import`.

```sh
clerk migrate export                                    # pick a platform
clerk migrate export clerk --output users.json
clerk migrate export auth0 --domain my-tenant.us.auth0.com \
  --client-id … --client-secret …
clerk migrate export workos --api-key sk_…
```

The platform is an optional positional. Omitted, you get a picker built from
the registry; given, it runs directly. Each platform resolves its own flags —
what Auth0 needs (a tenant domain and M2M credentials) has nothing in common
with what a database export needs.

**A credential the far end rejects is asked for again.** Connection strings,
Firebase service account keys and Auth0 client secrets are all long, pasted by
hand, masked as they are typed, and wrong in ways nothing local can check: a
typo'd host, a revoked key, an expired token, the right server but the wrong
database. Only the connection or the token exchange can say, and by then the
operator has answered every other question the command asked. So that step —
and only that step, never a fetch already under way or a file already written —
runs inside a retry: the failure is explained, the prompt comes back, and the
rest of the export continues against whichever credential worked. Agent mode
and a non-TTY fail outright instead, having nobody to ask, and `-y` fails too,
having been told not to.

| Platform     | Source                           | Feeds                 |
| ------------ | -------------------------------- | --------------------- |
| `clerk`      | Clerk Backend API                | `--source clerk`      |
| `auth0`      | Auth0 Management API             | `--source auth0`      |
| `supabase`   | Supabase Postgres (`auth.users`) | `--source supabase`   |
| `authjs`     | Auth.js database                 | `--source authjs`     |
| `betterauth` | Better Auth database             | `--source betterauth` |
| `firebase`   | Firebase Identity Toolkit        | `--source firebase`   |
| `workos`     | WorkOS User Management API       | `--source workos`     |

Every export is a [run](#clerk-migrate-runs), and the file lands in the run
folder as `export.json`. `--output` writes it somewhere else instead,
resolved against the **current directory** like every other path flag here;
the run still records where. Nothing is asked about where the file goes.

The file is an envelope around the users:

```json
{
  "clerkMigrate": 1,
  "source": "clerk",
  "exportedAt": "2026-09-29T14:15:02.000Z",
  "runId": "20260929-141502-a1b2",
  "users": [ … ]
}
```

`source` is what lets `clerk migrate import <export-run-id>` run with no
`--source`. A Firebase export adds `firebase`, the project's hash
parameters, so the import needs no `--firebase-*` flags.

`--json` prints the result on stdout instead — `{ target, run, output, users,
coverage, next }` — and never prompts, so a missing credential exits 2 naming
the flag to pass.

| Flag                       | Platforms                          | Description                                               |
| -------------------------- | ---------------------------------- | --------------------------------------------------------- |
| `-o, --output <path>`      | all                                | Write the export here instead of the run folder           |
| `-y, --yes`                | all                                | Do not prompt: fail on a bad credential                   |
| `--json`                   | all                                | Print the result as JSON; never prompts                   |
| `--db-url <url>`           | `supabase`, `authjs`, `betterauth` | Postgres, MySQL, libsql/Turso or SQLite connection string |
| `--service-account <path>` | `firebase`                         | Path to a service account key JSON file                   |
| `--domain <domain>`        | `auth0`                            | Tenant domain, e.g. `my-tenant.us.auth0.com`              |
| `--client-id <id>`         | `auth0`                            | Machine-to-machine application client ID                  |
| `--client-secret <secret>` | `auth0`                            | Machine-to-machine application client secret              |
| `--api-key <key>`          | `workos`                           | WorkOS secret API key, the one starting `sk_`             |
| `--with-identities`        | `workos`                           | Also record each user's OAuth providers                   |
| `--no-with-identities`     | `workos`                           | Skip the OAuth provider fan-out without being asked       |

`export clerk` also takes the targeting flags — it reads from a Clerk instance,
so it resolves a key the same way `clerk migrate import` does, with one extra
step. The linked project is usually the migration's _destination_, so taking it
as the source without asking is how a run exports an instance and imports it
back into itself. Instead:

- **Naming the instance runs unquestioned.** `--secret-key <sk_…>`, `--app`,
  `--instance`, or an exported `CLERK_SECRET_KEY` — any of them is a sentence
  you typed for this run, so none of them opens a picker. That is what makes
  the export scriptable outside agent mode, and it keeps an exported key
  outranking the linked profile here the way it does everywhere else in the
  CLI.
- Anything resolved on your behalf — the linked project, a keyless app — is
  never taken silently. A picker of every **instance** on your account opens
  instead — one flat row each, `my-app - Production instance (ins_…)`, not an
  application picker followed by an instance picker — with the resolved
  application's instances listed **first** so taking one is still a single
  Enter. Only when there are no instances to offer does it stop and list
  `--secret-key`, `--app`/`--instance` and `clerk link` instead.
- With nothing to resolve at all (no link, no key, no flags), you get the
  application picker `clerk users` uses — `Select a Clerk application to use:`,
  followed by an instance picker when the application has more than one —
  rather than an error about an unlinked directory. That is `clerk link`'s
  picker, so it does offer `+ Create a new application`; a brand-new
  application has no users to export, so it is never the answer here.

The instance picker (the second tier) has no "create a new application" choice.
Its rows are searchable by what they show, so typing an application name,
`production`, or an instance id all narrow it.

In agent mode the resolved instance is used without a prompt; pass
`--secret-key` or `--app`/`--instance` to be explicit.

After each export you get a field-coverage table — which Clerk-relevant fields
were present on how many users — so you know the data is thin _before_ you
import it, not after:

```
Field coverage
  ✓ 3/3 have an email address
  ✗ 0/3 have a phone number
  ! 1/3 have a username
  ! 2/3 have a password (not exportable — see below)

Exported 3 users to /project/.clerk/migrate/20260929-141502-a1b2/export.json
Run 20260929-141502-a1b2. See each user with `clerk migrate runs 20260929-141502-a1b2`.

Import them with:
  clerk migrate import 20260929-141502-a1b2

  Imports into whichever instance the resolved secret key belongs to.
  For production, add `--instance prod` or use a production secret key.
```

The import command prints through the same channel as the coverage table
rather than the gutter's **Next steps** outro, which is human-only — an agent
would otherwise be told what was exported and never how to import it.

There is one command, not a development and a production variant, because no
flag's absence means "development" — the resolved key decides, through
`--secret-key`, `--app`, `CLERK_SECRET_KEY`, the keyless project and the linked
profile in that order.

The export run has one line per exported user, so `clerk migrate runs` lists it
alongside imports. Every export takes `--runs-dir <path>` to keep that run
somewhere else.

#### Three platforms export no passwords

- **Clerk** never returns password digests, TOTP secrets or backup codes over
  the API — only the `*_enabled` booleans. Migrated users must reset their
  password in the destination instance.
- **Auth0**'s Management API does not return password hashes either; they come
  only from a support request. Add a `passwordHash` field to each user before
  importing, or migrate without passwords.
- **WorkOS** returns neither password hashes nor TOTP secrets, and has no
  support-request escape hatch: hashes go in on import and never come back, and
  `totp.secret` is returned on enrol only. There is nothing to add to the file.

All three say so on every run. The coverage row counts users who _have_ a
password, so the size of the gap is visible up front — `workos` prints that row
at zero unconditionally, because zero is the only value it can take.

#### Database-backed exports (`supabase`, `authjs`, `betterauth`)

These three read the database directly, over **`--db-url`**:

```sh
clerk migrate export supabase   --db-url "postgres://postgres:...@db.xxx.supabase.co:5432/postgres"
clerk migrate export authjs     --db-url "mysql://user:...@127.0.0.1:3306/authjs"
clerk migrate export betterauth --db-url "./db.sqlite"
clerk migrate export betterauth --db-url "libsql://app-org.turso.io?authToken=..."   # or set TURSO_AUTH_TOKEN
```

Postgres and MySQL go through `Bun.sql`; SQLite through `bun:sqlite`;
`libsql://` (Turso) over the server's HTTP pipeline endpoint, since `bun:sqlite`
only opens local files and `@libsql/client` ships native optional dependencies.
Nothing native ships in the binary — that is the whole reason the `engines.bun`
floor exists. Resolution is `--db-url`, then `SUPABASE_DB_URL` / `AUTHJS_DB_URL`
/ `BETTERAUTH_DB_URL`, then a masked prompt, since a connection string carries
the password inline. A libsql token comes from `?authToken=` on the URL, or from
`TURSO_AUTH_TOKEN` / `LIBSQL_AUTH_TOKEN`, and is redacted like a password.

**Connection strings are redacted everywhere.** Errors show
`postgres://***@host/db`, including when the password itself contains an
unencoded `@` — the most common mistake, and exactly when the string ends up in
an error message.

Connection failures get a hint rather than a driver error. Bun reports both an
unreachable host and a closed port as "Connection closed", so:

| Situation                | What you are told                                                                                 |
| ------------------------ | ------------------------------------------------------------------------------------------------- |
| Host or port unreachable | Check the host and port. On Supabase: use the pooler connection string, or enable the IPv4 add-on |
| Credentials rejected     | Check the user and password                                                                       |
| Table missing            | Check the database name and SELECT permission. On Supabase: enable Auth, connect as `postgres`    |
| SQLite file missing      | Check the path and that the file is readable                                                      |

**`supabase` reads the database rather than the Admin API** because
`encrypted_password` exists only there. An API-based export would force every
user to reset their password; this one carries the bcrypt digests across. It
also keeps `raw_app_meta_data`, which is what `--skip-unsupported-providers`
reads at import time.

**`authjs` tries `User`, then `user`, then `users`.** Auth.js has no single
schema — Prisma capitalizes the table, Drizzle does not, and Postgres treats
the difference as significant once quoted. The run reports which one it found.
Auth.js core stores no passwords, so its users arrive without credentials.

**`betterauth` detects its plugin columns from the schema.** The username
plugin adds `username`, admin adds `banned`, phone-number adds `phoneNumber`,
and so on; selecting a column that is not there fails the whole query, and the
database answers the question better than the user can. Passwords come from a
`LEFT JOIN` onto the credential `account` row — left, not inner, so a user who
only ever signed in with OAuth is still exported.

#### `firebase`

```sh
clerk migrate export firebase --service-account ./service-account.json
```

Needs a service account key from **Project settings → Service accounts →
Generate new private key**, with the Firebase Authentication Admin role.

Without `--service-account` you are prompted for it, the way `export supabase`
prompts for its connection string. The answer can be a path to the downloaded
file _or_ the key's JSON pasted whole, so a key kept in a password manager or a
CI secret never has to be written to disk. The prompt is masked, since the key
carries a private key. Agent mode cannot prompt, so it names the flag instead.

Either way the key is validated before anything reaches the network, so
downloading the web app config by mistake fails in a second with the right
console page named rather than after an auth round-trip. Key material never
appears in output.

Firebase's scrypt is a modified variant, so a digest is worthless without the
project's four hash parameters. The export **reads them from the project** and
saves them in the export file's envelope, so the import needs nothing more:

```
Password hash parameters
Read from the project and saved in the export file, so the import needs nothing more.
```

Reading the config needs a broader role than listing users, so if it is denied
the export still succeeds and points at **Authentication → Users → (⋮) →
Password hash parameters** instead. An export with no password hashes says so
and asks for nothing.

A user whose hash is present but whose salt is not (or the reverse) has both
dropped: half a credential produces a user nobody can sign in as.

`FIREBASE_AUTH_EMULATOR_HOST` is honoured, so this works against the local
Firebase emulator as well as production.

**No `firebase-admin`.** The spike the plan called for was run and _passed_ — a
compiled binary can import the SDK and complete `listUsers`, so the known
Firestore-under-compile bug does not reach the Auth Admin surface. It was still
not adopted: the SDK is 74 MB across 158 packages, including Firestore and
Cloud Storage, which would roughly double the ~62 MB binary every user
downloads, to serve one subcommand. What it does here is two REST calls and an
RS256 JWT, and Bun's Web Crypto signs RS256 with no dependency at all.

#### Auth0 credentials

Needs a machine-to-machine application with the `read:users` scope
(Applications → APIs → Auth0 Management API → Machine to Machine
Applications). Resolved from flags, then `AUTH0_DOMAIN` / `AUTH0_CLIENT_ID` /
`AUTH0_CLIENT_SECRET`, then a prompt. In agent mode a prompt is impossible, so
it exits naming **every** missing credential at once rather than one per run.

Auth0 pages this endpoint only through the first **1000** users. Past that the
export stops and says so, pointing at Auth0's bulk export job — silently
returning the first thousand would read as "that is everyone".

#### WorkOS credentials

Needs a secret API key — the one starting `sk_`, from the WorkOS dashboard
under API Keys. Resolved from `--api-key`, then `WORKOS_API_KEY`, then a
prompt; agent mode exits naming both instead.

There is no `--db-url` sibling because there is no database to point it at.
WorkOS is API-only: apps commonly mirror users into their own store through
webhooks, but that mirror is a derived copy holding no credentials, so the
User Management API is the only source. Pagination is cursor-based, so unlike
Auth0 there is no record ceiling — `after` runs to the end of the tenant.

**`--with-identities` is off by default, and it is not free.** WorkOS has no
bulk endpoint for OAuth identities, so it is one request per user: ten requests
becomes 1,010 for a thousand users. Nothing it returns can be imported —
`POST /v1/users` has no external-accounts field — so it buys a provider
breakdown in the coverage report, and an `identities` array kept in the export
file for whoever runs the migration. The interactive path asks once, after the
user count is known, defaulting to no; agent mode takes the flag's answer and
asks nothing. `-y` answers the question `yes`, so pass
`--no-with-identities` to skip the fan-out without being asked.

The breakdown prints as its own **OAuth providers** block under the coverage
table, not as extra coverage rows:

```
Field coverage
  ✓ 6/6 have an email address
  ✗ 0/6 have a password (WorkOS returns none)

OAuth providers
  GoogleOAuth        2 users
  MicrosoftOAuth     1 user
  no OAuth provider  2 users
  not readable       1 user
  Those users have no `identities` field in the export, rather than an empty one.
```

Separate because the two kinds of row do not mean the same thing. A coverage
row is "N of the M users have this field"; a provider row has no such
denominator — one user holding two providers is counted under both, so the
counts can sum past the user count, and `not readable` is not a property of the
user at all.

A lookup that fails is counted on its own row rather than folded into
`no OAuth provider`. "Lookup failed" and "has no providers" are different
facts, and flattening the first into the second would understate social
sign-in.

Non-interactive runs get progress on stderr every 500 users during the fan-out,
and every 10 pages during the user fetch. `withSpinner` hands a no-op to
anything that is not a TTY, so without this an agent exporting a large tenant
would see nothing at all until the run finished.

### `clerk migrate undo`

Deletes the users an import run created. The import run is the whole record of
what to delete: every source ID whose latest line is `created`, by the Clerk ID
recorded beside it. Nothing is matched by searching the instance, so a user the
import did not create is never in scope.

```sh
clerk migrate undo 20260929-141502-a1b2 --dry-run   # preview, delete nothing
clerk migrate undo 20260929-141502-a1b2             # confirms first
clerk migrate undo 20260929-141502-a1b2 --yes       # no prompt
```

| Flag                | Description                                              |
| ------------------- | -------------------------------------------------------- |
| `<run-id>`          | The import run to undo                                   |
| `--dry-run`         | Show the preview and delete nothing                      |
| `-y, --yes`         | Delete without prompting                                 |
| `--json`            | Output as JSON. Never prompts, so deleting needs `--yes` |
| `--runs-dir <path>` | Read runs from somewhere else                            |

Plus the targeting flags: `--secret-key`, `--app` and `--instance`.

It prints the target first, then a preview: how many users will be deleted, and
how many of them have signed in since the import (from each user's
`last_sign_in_at`). Nothing is deleted without consent: a yes at the prompt, or
`--yes`. Without either — an agent, a non-TTY run, or `--json` — it prints the
preview and exits 2 with the command to run.

It refuses with exit 2, and deletes nothing, when:

- the resolved key addresses a different instance than the run imported into
  (the error names both)
- the run is an export or undo run
- the run has already been undone

Deletes go through the same scheduler and `429` backoff as the import. A user
already gone from the instance counts as deleted. The undo is a run of its own,
`kind: "undo"` with `undoes: <id>`. The import is marked `undone` only when
every user is deleted. A partial undo exits 1, and running `undo` again retries
the users that failed, in the same undo run.

### `clerk migrate runs`

Every import, export and undo is a **run**, and the run store is the one place
`clerk migrate` keeps state. `runs` reads it.

```sh
clerk migrate runs                           # every run, newest first
clerk migrate runs 20260929-141502-a1b2      # one run in full
clerk migrate runs --json
```

| Flag                | Description                   |
| ------------------- | ----------------------------- |
| `[run-id]`          | Show one run instead of all   |
| `--json`            | The same data, on stdout      |
| `--runs-dir <path>` | Read runs from somewhere else |

It prints the runs folder first. The listing shows each run's ID, date, kind,
status, target, file and counts. `runs <id>` adds the error breakdown and the
users that failed or were skipped, with the path to the full record. An unknown
ID exits 2.

#### Where runs are kept

The first of these that is set:

1. `--runs-dir <path>`
2. `CLERK_MIGRATE_DIR`
3. `<project root>/.clerk/migrate/`

The project root is the linked profile's directory, then the git toplevel, then
the current directory. Writing to the default location adds `.clerk/` to the
project's `.gitignore` first, because run files carry user data.

#### What a run holds

Each run is a folder named for its ID, `YYYYMMDD-HHmmss-xxxx`:

| File           | Contents                                                                                                 |
| -------------- | -------------------------------------------------------------------------------------------------------- |
| `run.json`     | Kind, status, start and finish times, the target, the source, the file and its sha256, and the counts    |
| `users.ndjson` | One line per user outcome: `sourceId`, `clerkId`, `status`, and `reason`, `error` or `code` when present |
| `lock`         | The PID of the process writing the run, while it runs                                                    |

A user's status is `created`, `failed`, `skipped`, `deleted` or `exported`. The last line
for each `sourceId` wins. A `429` retry, an extra email or phone that did not
attach, and a validation failure all land in `error`.

A run is `partial` when any user failed or was skipped, and `complete`
otherwise. A run whose process died, or that never recorded a finish time,
lists as `interrupted`. A lock held by a live process refuses a second writer
with exit 2.

## Sources

A source maps one platform's export onto Clerk's user schema, and says what it
brings across. Adding a platform is one file in `sources/` plus one line in
`sources/registry.ts`; `--source`'s tab-completion reads from that array.

| Key          | Reads                         | Passwords | MFA     | Metadata |
| ------------ | ----------------------------- | --------- | ------- | -------- |
| `clerk`      | Clerk Dashboard export        | partial   | partial | yes      |
| `auth0`      | Auth0 Export Users API        | partial   | no      | yes      |
| `authjs`     | Auth.js / NextAuth user table | no        | no      | no       |
| `betterauth` | Better Auth export            | yes       | no      | no       |
| `firebase`   | `firebase auth:export`        | yes       | no      | no       |
| `supabase`   | Supabase `auth.users` export  | yes       | no      | partial  |
| `workos`     | WorkOS User Management API    | no        | no      | yes      |

There is no column for social sign-ins, because no source copies them and none
needs to. Every source shows the same note instead: enable the same providers in
Clerk, and a user who signs in with one is linked to their imported account by
verified email. See
[account linking](https://clerk.com/docs/guides/configure/auth-strategies/social-connections/account-linking).

### `clerk migrate sources`

```sh
clerk migrate sources                 # every source, with what it carries
clerk migrate sources betterauth      # one source in full
clerk migrate sources ./my-source.ts  # a source you wrote
clerk migrate sources --json
```

| Flag       | Description                                                      |
| ---------- | ---------------------------------------------------------------- |
| `[source]` | A built-in key, or the path to a source you wrote, to show fully |
| `--json`   | The same data, on stdout                                         |

`sources` alone prints the table above. `sources <source>` shows one source in
full: its export command, what it carries with a note for each, where each
field lands (`encrypted_password → password`), its fixed defaults, and any
caveats. An unknown key exits 2 and lists the valid ones. There is no
intro/outro gutter: this reads a static registry rather than running anything.

### `--source`

`clerk migrate import` takes `--source <key|path>`:

- A value starting with `./`, `../` or `/`, or ending in `.ts`, `.js` or
  `.mjs`, is loaded as a [custom source](#custom-sources).
- Anything else must be a built-in key. An unknown key exits 2 with the list of
  valid keys.

A file `clerk migrate export` wrote names its own source, so it needs none.

### Custom sources

Migrating from a platform with no built-in, without recompiling the CLI:

```sh
clerk migrate import users.json --source ./my-platform.ts
```

The file lives in **your** project, not in the CLI, and is imported at runtime.
It exports the same shape the built-ins use — plain data, no imports, since
there is nothing in a compiled binary for your file to import from:

```ts
export default {
  key: "myplatform",
  label: "My Platform",
  description: "Exports from My Platform's admin console.",
  transformer: {
    account_ref: "userId", // required: becomes the Clerk user's external_id
    contact_email: "email",
    given: "firstName",
    family: "lastName",
    pw_bcrypt: "password",
  },
  carries: {
    passwords: { level: "yes", note: "bcrypt hashes from the pw_bcrypt column." },
    mfa: { level: "no", note: "Not exported." },
    metadata: { level: "no", note: "Not exported." },
  },
  defaults: { passwordHasher: "bcrypt" },
  postTransform: (user) => {
    if (!user.firstName) delete user.firstName;
  },
};
```

TypeScript is fine — Bun's transpiler is part of the runtime, so `interface`,
`satisfies` and `as const` all work in a file the compiled binary imports.
Plain `.js` works too.

An import run records a custom source's key and a hash of the file, so an
edited source counts as a different source.

#### Validation

The file is code the CLI executes, so its shape is checked before use and
rejected with the specific problem rather than crashing mid-pipeline:

| Problem                            | Message                                                                                                    |
| ---------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| Path does not exist                | `No source file at /abs/path.ts.`                                                                          |
| No default export, but a named one | ``has no default export. Found named export `myPlatform` — did you mean `export default`?``                |
| Does not parse                     | `Could not load ./f.ts: Expected identifier but found ","`                                                 |
| Nothing maps to `userId`           | ``no source field maps to `userId`. Every user needs one — it becomes the Clerk user's external_id``       |
| No `carries`                       | `` `carries` must say what the source brings across: { passwords, mfa, metadata }, each { level, note } `` |
| `key` clashes with a built-in      | `key is "clerk", which is already a built-in source`                                                       |
| A hook is not a function           | `postTransform must be a function when present`                                                            |

The `userId` check is the load-bearing one: without it the import would run to
completion and create every user with no `external_id`, which is what makes a
migration re-runnable.

### Verified vs unverified identifiers

Every platform records verification differently, and each source declares
which style it uses. An identifier the source never confirmed is routed to
`unverifiedEmailAddresses` / `unverifiedPhoneNumbers` rather than the primary
field, because Clerk creates primary identifiers **verified** — sending an
unconfirmed address there would silently promote it.

- **Boolean** (`auth0`, `betterauth`, `firebase`): `true`/`false`. A CSV export
  stringifies these, so `"false"` is read as false, not as a non-empty string.
- **Timestamp** (`authjs`, `supabase`): a nullable confirmation time. Any real
  value means verified; `""`, `null` and `\N` do not.

### Firebase hash parameters

Firebase uses a modified scrypt, so Clerk needs the project's four parameters
alongside each digest. Find them in the Firebase console under
**Authentication → Users → (⋮) → Password hash parameters**.

```sh
clerk migrate import users.json --source firebase -y \
  --firebase-signer-key <key> --firebase-salt-separator <sep> \
  --firebase-rounds 8 --firebase-mem-cost 14
```

All four are **required as a set** — supplying some but not all is a usage error
naming what is missing. A partial set produces a well-formed digest that
verifies against nothing, so users would import successfully and then be unable
to sign in.

The flags are read first, then the export file's envelope, which carries the
parameters when `clerk migrate export firebase` could read them from the
project. The flags win, so a rotated key can be passed without re-exporting.
The envelope sits in the gitignored run folder, since the signer key is a
Firebase secret.

An export with no password hashes needs no parameters at all.

### `--skip-unsupported-providers` (Supabase)

Reads each user's `raw_app_meta_data.providers` and cross-references it against
the social providers the destination instance has enabled (via BAPI
`/v1/domains` → the instance's Frontend API `/v1/environment`).

A user is skipped **only when every one of their providers is disabled**. Anyone
who can still sign in another way — email, phone, or an enabled social provider
— is imported. The number skipped is reported, broken down by provider.

If the instance configuration cannot be read, nobody is skipped and a warning is
printed: a failed lookup must not be mistaken for "no providers are enabled".

## Schema fields

What a source maps _onto_. Every user is validated against this schema
before any request is made, so a field a source produces that is not listed
here is silently dropped — Zod strips unknown keys — and never reaches Clerk.
Writing a custom source means targeting these names exactly.

The schema lives in `validator.ts`; adding a platform means adding a source,
not editing it.

**Required:** `userId` (`string`). It becomes the Clerk user's `external_id`,
which is what makes a migration re-runnable.

**Identifiers.** At least one of these must be present, or the user is logged as
a validation failure and skipped. Each accepts a single value or an array.

| Field                      | Type                 | Description                        |
| -------------------------- | -------------------- | ---------------------------------- |
| `email`                    | `string \| string[]` | Primary verified email address(es) |
| `emailAddresses`           | `string \| string[]` | Additional verified emails         |
| `unverifiedEmailAddresses` | `string \| string[]` | Unverified emails                  |
| `phone`                    | `string \| string[]` | Primary verified phone number(s)   |
| `phoneNumbers`             | `string \| string[]` | Additional verified phones         |
| `unverifiedPhoneNumbers`   | `string \| string[]` | Unverified phones                  |
| `username`                 | `string`             | Username                           |

**Profile, password and 2FA.**

| Field                | Type       | Description                                         |
| -------------------- | ---------- | --------------------------------------------------- |
| `firstName`          | `string`   | First name                                          |
| `lastName`           | `string`   | Last name                                           |
| `password`           | `string`   | The hashed password from the source platform        |
| `passwordHasher`     | `enum`     | **Required whenever `password` is set** (see below) |
| `totpSecret`         | `string`   | TOTP secret                                         |
| `backupCodesEnabled` | `boolean`  | Whether backup codes are enabled                    |
| `backupCodes`        | `string[]` | Backup codes                                        |

Clerk verifies the digest as-is, so `passwordHasher` must name the algorithm the
source actually used:

`argon2i`, `argon2id`, `awscognito`, `bcrypt`, `bcrypt_peppered`,
`bcrypt_sha256_django`, `hmac_sha256_utf16_b64`, `ldap_ssha`, `md5`,
`md5_phpass`, `md5_salted`, `pbkdf2_sha1`, `pbkdf2_sha256`,
`pbkdf2_sha256_django`, `pbkdf2_sha512`, `pbkdf2_sha512_hex`, `scrypt_firebase`,
`scrypt_werkzeug`, `sha256`, `sha256_salted`, `sha512_symfony`

An unrecognized hasher aborts the run rather than importing credentials nobody
can sign in with.

**Metadata.**

| Field             | Type     | Description                                              |
| ----------------- | -------- | -------------------------------------------------------- |
| `unsafeMetadata`  | `object` | Readable **and writable** by the client — never trust it |
| `publicMetadata`  | `object` | Readable by the client, writable only server-side        |
| `privateMetadata` | `object` | Server-side only                                         |

**Account state.** These are passed straight through to `POST /v1/users`, and
are how a Clerk-to-Clerk migration keeps original signup dates instead of
stamping every user with today's.

| Field                       | Type      | Description                               |
| --------------------------- | --------- | ----------------------------------------- |
| `createdAt`                 | `string`  | Original creation timestamp               |
| `legalAcceptedAt`           | `string`  | When legal terms were accepted            |
| `banned`                    | `boolean` | Whether the user is banned                |
| `bypassClientTrust`         | `boolean` | Skip client trust verification            |
| `createOrganizationEnabled` | `boolean` | Whether the user can create orgs          |
| `createOrganizationsLimit`  | `number`  | Maximum orgs the user can create          |
| `deleteSelfEnabled`         | `boolean` | Whether the user can delete their account |
| `skipLegalChecks`           | `boolean` | Skip legal acceptance checks              |
| `skipPasswordChecks`        | `boolean` | Skip password requirements on import      |

## Migration Readiness report

Printed immediately before the confirmation prompt, so declining aborts with
nothing written to Clerk. Skipped only for `-y`, which says "don't ask, don't
lecture" and should not pay for the two extra round-trips. Agent runs without
`-y` still get it — an agent can act on it exactly as a human would.

It cross-references the file against the destination instance's live settings
(BAPI `/v1/domains` → that instance's Frontend API `/v1/environment`) and
answers the two questions worth answering before writing anything: **who won't
be imported**, and **who will arrive incomplete**.

```
Migration readiness
  120 users in this file
  3 failed validation and will be skipped

  ✗ 12 users will not be imported
      12 have no email, which this instance requires
      If you import them, this applies to them too:
        12 have a phone, which this instance is not set up to store
  ⚠ 20 users will be imported, but not everything they carry
      14 have no password, which this instance requires — they will have to reset it to sign in
      6 have a username, which this instance is not set up to store
  ✓ 88 users will be imported in full

Identifiers
  ⚠ Email — required in Clerk, and not every user has one — 108/120 users
  ⚠ Username — not enabled in Clerk — 6/120 users

Social connections
  ✓ Google — enabled in Clerk — 40/120 users
  ⚠ Discord — not enabled in Clerk — 12/120 users

⚠ 3 settings need attention
```

### The two blocks

**The outcome block** classifies each user **once**, into the worst outcome that
applies to them, so its three totals add up to the file. This matters: per-field
coverage cannot answer "how many won't be imported", because the users missing
an email and the users missing a password overlap by an amount only a per-user
pass knows. A user rejected for their missing email is not also counted under
the missing password they happen to share.

**"If you import them, this applies to them too"** is the part that stops the
settings interacting invisibly. A user who is not being created cannot lose a
field, so a setting that only affects rejected users costs nothing _today_ and
would otherwise never be mentioned — right up until the operator relaxes the
requirement rejecting them, at which point all of it lands at once. Naming it
up front is what turns

> make email optional → re-check → discover the phones are being dropped →
> enable phone → re-check

into a single decision with both offers visible. It is also why a setting can
be flagged in the section rows while contributing nothing to the ✗/⚠/✓ totals.

**The section rows below** are the other question — per-field coverage against
each setting — and deliberately do not restate user counts, which would read as
contradicting the block above.

### Which settings cost what

| Setting                                    | Consequence                                                                                   |
| ------------------------------------------ | --------------------------------------------------------------------------------------------- |
| Identifier (email/phone/username) required | **Not imported.** `POST /v1/users` enforces the sign-up identifier requirements.              |
| Password required, user has none           | **Imported without a password.** The import sends `skip_password_requirement`, so the user is |
|                                            | created and has to reset their password before they can sign in with one.                     |
| Attribute disabled in Clerk                | **Imported without that field.** The instance has nowhere to put it.                          |
| Social provider disabled                   | **Imported**, but that sign-in method is unavailable to them.                                 |

Social rows are not part of the per-user outcome counts: which providers a user
signed up with lives in the raw export rather than the transformed user, so it
cannot be attributed per user. Their coverage row still names them.

If the instance settings cannot be read — the secret key is rejected, or FAPI
is unreachable — the report degrades to a coverage-only listing with a note.
Nothing is flagged in that case: "could not read" is not the same as "switched
off", and treating it as such would raise alarms about settings that are
perfectly fine.

### Changing the flagged settings

When the report flags anything, a human run offers one selectable change per
flagged row before the import confirmation, so acting on the report does not
mean leaving the CLI for the dashboard:

```
Update this instance's settings first? (enter to skip)
  ◻ Make Email optional at sign-up
  ◻ Enable Discord sign-in
  ↑/↓ to navigate • Space: select • a: all • Enter: confirm
```

**Nothing is preselected** — relaxing an instance's sign-up requirements is a
real decision, not a default — and selecting nothing continues to the import
prompt with the instance untouched, which is what "enter to skip" is there to
say.

`a: all` is added to clack's legend in `lib/prompts.ts`: `MultiSelectPrompt`
has always bound `a` to toggle everything (and `i` to invert), but clack's
footer never listed them and takes no override, so the key was undiscoverable.
It applies to every multiselect in the CLI, because it is a property of the
prompt rather than of any one question.

These are offers, not corrections: **a flagged setting is not a wrong setting.**
An instance that genuinely requires an email address is configured exactly as
its owner intended, and the right answer may well be to fix the export instead.

Whatever is selected becomes a single `PATCH` of the instance config document,
the same document `clerk config patch` writes. The report is then redrawn so
the confirmation that follows is against the settings the write established.

**The offer repeats while anything is still flagged.** A redraw is another
decision point, not a receipt: applying one change routinely leaves others
worth making, and each round re-offers only what is left. It ends when the
report has nothing flagged, when the operator selects nothing, or when there is
nothing offerable for the rows that remain — so reaching the second change
never costs a second run of the command.

The redraw is computed from the write, **not** from a second settings fetch.
Clerk's Frontend API is eventually consistent, so a `/v1/environment` read
issued this soon after the config write routinely still reports the pre-write
settings — which would redraw the report with every row the operator just
cleared still flagged. The Platform API accepting the write is the
authoritative statement of what took, exactly as `clerk config patch` treats
it (see that command's [round-trip verification](../config/README.md#round-trip-verification)
notes for the same reasoning).

The config leaves each option writes are not shown in the prompt — internal
detail an operator cannot act on — but they are fixed and listed here:

| Flagged row                     | Change offered                                                                    |
| ------------------------------- | --------------------------------------------------------------------------------- |
| Email/Phone/Username — required | `auth_<x>.required_for_sign_up → false`                                           |
| Email — disabled                | `auth_email.used_for_sign_up → true` + `verification_strategies → ["email_code"]` |
| Phone — disabled                | `auth_phone.used_for_sign_up → true` + `verification_strategies → ["phone_code"]` |
| Username — disabled             | `auth_username.used_for_sign_up → true`                                           |
| Password — required / disabled  | `auth_password.required → false` / `auth_password.enabled → true`                 |
| First/Last name                 | `user_model.<x>.required → false` / `user_model.<x>.enabled → true`               |
| Social provider — disabled      | `connection_oauth_<x>.enabled → true`                                             |

`used_for_sign_up` is the enable field that matters: `POST /v1/users` validates
an import against the instance's sign-up requirements, not its sign-in
strategies.

**Email and phone take two writes, not one.** They are _verifiable_ attributes,
and Clerk rejects one that is on with no way to verify it:

```
422 phone_number: verifiable attributes need to have at least one verification
```

Switching the attribute off empties `verification_strategies`, so whatever
turns it back on has to put a strategy back in the same request. Username,
password and the name fields are not verifiable and take one write each.

The offer is skipped entirely for `-y` and in agent mode, both of which say
"don't prompt". It also stands down, with a warning rather than a failed run,
when the instance to configure cannot be resolved (a bare `--secret-key` in an
unlinked directory) or when it is a **keyless** application — the Backend API
those are reachable through has no route for any of these settings, so
`clerk auth login` is the way in.

## Artifacts

| Path                              | Contents                                                |
| --------------------------------- | ------------------------------------------------------- |
| `<runs dir>/<run-id>/`            | One [run](#what-a-run-holds) per import, export or undo |
| `<runs dir>/<run-id>/export.json` | An export's envelope, unless `--output` says otherwise  |

`users.ndjson` writes are synchronous appends, so a run interrupted with Ctrl-C
still leaves a complete record of everything already processed.

### Why `users.ndjson` is NDJSON

One JSON object per line, rather than one JSON array per file. A migration is a
long append-only stream, and that format is the one that survives it:

- **Appendable.** Each entry is written as it happens, without rewriting the
  file. A JSON array would have to be re-serialized on every user.
- **Crash-safe.** Kill the process at any point and every line already written
  is still valid. A truncated array is not parseable at all.
- **Streamable.** `tail -f` shows a long import progressing live, and analysis
  reads line by line instead of loading a million-user record into memory.

Which is also why it greps usefully without any tooling:

```sh
grep '"status":"created"' .clerk/migrate/20260929-141502-a1b2/users.ndjson | wc -l
grep '"sourceId":"user_123"' .clerk/migrate/20260929-141502-a1b2/users.ndjson
```

## API Endpoints

| Method | Path                       | Used by                                                                              |
| ------ | -------------------------- | ------------------------------------------------------------------------------------ |
| `POST` | `/v1/users`                | `migrate import` — creates each user                                                 |
| `POST` | `/v1/email_addresses`      | `migrate import` — attaches additional emails                                        |
| `POST` | `/v1/phone_numbers`        | `migrate import` — attaches additional phones                                        |
| `GET`  | `/v1/users?limit=&offset=` | `migrate export clerk` — pages the whole instance, 500 at a time                     |
| `GET`  | `/v1/users/count`          | `migrate import` — headroom against a development instance's user limit              |
| `GET`  | `/v1/domains`              | Readiness report and `--skip-unsupported-providers` — resolves the Frontend API host |

The readiness report also reads the instance's Frontend API
`GET /v1/environment` (bootstrapping a dev browser first on development
instances), and its settings-change offer writes through the Platform API:

| Method  | Path                                                              | Used by                                                |
| ------- | ----------------------------------------------------------------- | ------------------------------------------------------ |
| `PATCH` | `/v1/platform/applications/{appID}/instances/{instanceID}/config` | Applying the settings changes selected from the report |

Three exports talk to their own platform rather than to Clerk:

| Method | Path                                           | Used by                                                  |
| ------ | ---------------------------------------------- | -------------------------------------------------------- |
| `POST` | `https://<tenant>/oauth/token`                 | `export auth0` — Management API access token             |
| `GET`  | `https://<tenant>/api/v2/users`                | `export auth0` — 100 per page, 1000 users maximum        |
| `POST` | `https://oauth2.googleapis.com/token`          | `export firebase` — RS256 assertion → access token       |
| `GET`  | `…/v1/projects/{project_id}/accounts:batchGet` | `export firebase` — pages users, 1000 at a time          |
| `GET`  | `…/admin/v2/projects/{project_id}/config`      | `export firebase` — reads the scrypt hash parameters     |
| `GET`  | `…/user_management/users`                      | `export workos` — 100 per page, cursor-paginated         |
| `GET`  | `…/user_management/users/{id}/identities`      | `export workos` — `--with-identities` only, one per user |

The two Identity Toolkit paths are on `identitytoolkit.googleapis.com`, or on
`FIREBASE_AUTH_EMULATOR_HOST` when that is set. The two WorkOS paths are on
`api.workos.com`.

The three database exports (`supabase`, `authjs`, `betterauth`) make no HTTP
calls at all — they connect over `--db-url`.

The readiness report and `--skip-unsupported-providers` additionally read the
instance's Frontend API `GET /v1/environment` for its attributes and enabled
social providers.

## Notes

- `userId` in the source file becomes the Clerk user's `external_id`. That is
  what makes a migration re-runnable and reversible.
- CSV input is coerced before validation: `a@x.dev,b@x.dev` and `["a@x.dev"]`
  both become arrays, `"true"`/`1` become booleans, and JSON metadata columns
  are parsed. An empty column is dropped rather than sent as null.
- A user must end up with at least one identifier (email, phone or username).
  Users that do not are logged as validation failures and skipped.
