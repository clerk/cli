# `clerk migrate`

Migrate users into a Clerk instance from another auth provider, or from another
Clerk instance.

```
clerk migrate export [platform] [-o <path>] [--json]
clerk migrate import [file|export-run-id] [--source <source>] [--dry-run] [--allow-partial] [--new-run] [--yes] [--json]
clerk migrate runs [run-id] [--json]
clerk migrate undo <run-id> [--dry-run] [--yes] [--json]
clerk migrate sources [source] [--json]
clerk migrate help
```

A migration is usually three steps:

```sh
clerk migrate export supabase                         # 1. a run, holding export.json
clerk migrate import 20260929-141502-a1b2 --dry-run   # 2. check it against the instance
clerk migrate import 20260929-141502-a1b2 --yes       # 3. import it
```

`clerk migrate undo <run-id>` takes an import back out, and `clerk migrate runs`
shows what every run did. Every subcommand but `sources` takes `--runs-dir <path>`
(or `CLERK_MIGRATE_DIR`) to keep its runs somewhere else.
`clerk migrate` on its own is a group name, not a command: it prints its help.

## The rules

Every command follows these:

1. **Nothing writes without consent.** Consent is a yes at a terminal prompt, or
   `--yes`. Without either, `import` and `undo` print what they would do and
   exit 2 with the command to run. `--json` means non-interactive: it never prompts.
2. **`--dry-run` checks against the real instance, and writes nothing.** An
   import's [checks](#checks) run before anything is written. Predicted
   rejects stop the import unless `--allow-partial` is passed; fields that would
   be dropped are warnings.
3. **State lives in one place: the [run store](#the-run-store).** Each run
   records its target, its file, and every source ID → Clerk ID outcome,
   including the error for each user who failed. `runs`, `undo`, re-runs and
   exports all read or write it.
4. **Every command prints its target first:** the environment, app and
   instance, and where the key came from.
5. **Every subcommand takes `--json`.** Exit codes: `0` all good, `1` some users
   failed, `2` a usage error or a refusal, and `130` (death by SIGINT) when
   Ctrl-C stops an import or an undo partway. The UI goes to stderr and data to
   stdout.

   While users are created or deleted, a terminal shows a bar and the counts under it, not
   a spinner:

   ```
   │  ██████████████████████████████████████████████████████░░░░░░░░░░░░░░░░░░  75%
   │  7,500/10,000 users  ·  ✓ 7,425 created  ·  ✗ 75 failed  ·  ~25s left
   ```

   A spinner takes the keyboard and exits 0 on Ctrl-C, so a script that deletes
   the export once the import succeeds would delete it after an interrupted
   one. Without a terminal, the counts are printed at each 10%.

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

With a key from `--secret-key` or `CLERK_SECRET_KEY`, the key alone picks the
instance, so `import` and `undo` refuse (exit 2) an `--instance` that names a
different one. `--instance dev` next to an exported `sk_live_…` key would otherwise write
to production.

The **instance type is read from the key**: `sk_live_…` is treated as
production, anything else as development. That choice drives the throughput
defaults and the development-instance user limit below.

**Every command prints its target first.** `import` and `undo` name the
instance — its
environment, its app when the key came from one, and its ID from
`GET /v1/instance` — and where the key came from: `--secret-key`, `--app`, the
`CLERK_SECRET_KEY` env var, an accountless app's `.env.local`, or the linked
profile. An export names its source platform instead, and `export clerk` the
instance it reads. `runs` names the runs folder. `--json` carries the same
facts as `target`.

```
Target: My App (app_2x9k…), production instance ins_2x9k…
Key from: linked profile
```

The instance ID is what a run records, so `undo` and re-runs can tell whether
the key now in use still addresses the same instance.

## The run store

Every import, export and undo is a **run**, and the run store is the one place
`clerk migrate` keeps state.

### Where runs are kept

The first of these that is set:

1. `--runs-dir <path>`
2. `CLERK_MIGRATE_DIR`
3. `<project root>/.clerk/migrate/`

The project root is the linked profile's directory, then the git toplevel, then
the current directory. The first run written to the default location adds
`.clerk/` to the project's `.gitignore`, because run files carry user data. That
happens only once there is consent to write: a dry run or a refused import
leaves `.gitignore` alone.

### What a run holds

Each run is a folder named for its ID, `YYYYMMDD-HHmmss-xxxx`:

| File           | Contents                                                                                                                               |
| -------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `run.json`     | Kind, status, start and finish times, the target, the source, the file and its sha256, and the counts                                  |
| `users.ndjson` | One line per user outcome: `sourceId`, `clerkId`, `status`, and `reason`, `error`, `code`, `pending` or `passwordDropped` when present |
| `lock`         | The PID of the process writing the run, while it runs                                                                                  |

A user's status is `creating`, `created`, `failed`, `skipped`, `deleted` or
`exported`. The last line for each `sourceId` wins. A `429` retry, an extra email or phone that did not
attach, and a validation failure all land in `error`.

`creating` is written as a user's `POST /v1/users` goes out. It stays the
latest line when no answer says whether the create landed: an abort, a
network error, or a 5xx. A `created` line with `pending` lists the extra emails
and phones not yet attached.

A run is `partial` when any user failed, was skipped or is still `creating`,
and `complete` otherwise. A run whose process died, or that never recorded a
finish time, lists as `interrupted`. A lock held by another live process
refuses a second writer with exit 2, and names the lock file to delete if that
process is not a migrate run. A lock holding this process's own PID is stale:
in a container the CLI often gets the same PID every run.

Run folders are created owner-only (`0700`), and export files `0600`: they hold
password hashes and user data.

`users.ndjson` writes are synchronous appends, so a run interrupted with Ctrl-C
still leaves a complete record of everything already processed. A line that
cannot be written stops that user's create from going out. An export's file
lands in its run folder as `export.json` unless `--output` says otherwise.

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

## Commands

The direction is always spelled out — `migrate import` moves users **into**
Clerk, `migrate export` gets them **out** of a source platform — so neither is
implied by the group.

### `clerk migrate export`

Gets users **out** of a source platform, so there is something to feed
`clerk migrate import`.

```sh
clerk migrate export                                    # pick a platform
clerk migrate export clerk --output users.json
clerk migrate export auth0 --domain my-tenant.us.auth0.com \
  --client-id … --client-secret …
clerk migrate export supabase --db-url "postgres://postgres:...@db.xxx.supabase.co:5432/postgres"
clerk migrate export authjs --db-url "mysql://user:...@127.0.0.1:3306/authjs"
clerk migrate export betterauth --db-url "./db.sqlite"
clerk migrate export firebase --service-account ./service-account.json
clerk migrate export workos --api-key sk_…
```

The platform is an optional positional. Omitted, you get a picker built from
the registry; given, it runs directly. Each platform resolves its own flags —
what Auth0 needs (a tenant domain and M2M credentials) has nothing in common
with what a database export needs.

**A credential the far end rejects is asked for again.** Connection strings,
Firebase service account keys and Auth0 client secrets are all long, pasted by
hand, masked as they are typed, and wrong in ways nothing local can check: a typo'd host, a revoked key,
an expired token, the right server but the wrong database. Only the connection
or the token exchange can say, and by then the operator has answered every
other question the command asked. So that step — and only that step,
never a fetch already under way or a file already written — runs inside a
retry: the failure is explained, the prompt comes back, and the rest of the
export continues against whichever credential worked. Agent mode and a non-TTY
fail outright instead, having nobody to ask, and `-y` fails too, having been
told not to.

| Platform     | Source                           | Feeds                 |
| ------------ | -------------------------------- | --------------------- |
| `clerk`      | Clerk Backend API                | `--source clerk`      |
| `auth0`      | Auth0 Management API             | `--source auth0`      |
| `supabase`   | Supabase Postgres (`auth.users`) | `--source supabase`   |
| `authjs`     | Auth.js database                 | `--source authjs`     |
| `betterauth` | Better Auth database             | `--source betterauth` |
| `firebase`   | Firebase Identity Toolkit        | `--source firebase`   |
| `workos`     | WorkOS User Management API       | `--source workos`     |

Every export is a [run](#the-run-store), and the file lands in the run
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
| `-y, --yes`                | all                                | Do not prompt: fail on a rejected credential              |
| `--json`                   | all                                | Print the result as JSON; never prompts                   |
| `--runs-dir <path>`        | all                                | Where runs are kept (see [the run store](#the-run-store)) |
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
alongside imports.

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
/ `BETTERAUTH_DB_URL`, then a masked prompt, since a connection string carries the password inline. A password
pasted unencoded (`#`, `@`, `/` and the like) is percent-encoded for you. A libsql
token comes from `?authToken=` on the URL, or from `TURSO_AUTH_TOKEN` /
`LIBSQL_AUTH_TOKEN`, and is redacted like a password.

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
also keeps `raw_app_meta_data`, which is what the import's
[checks](#checks) read for each user's providers.

**`authjs` tries `User`, then `user`, then `users`.** Auth.js has no single
schema — Prisma capitalizes the table, Drizzle does not, and Postgres treats
the difference as significant once quoted. The run reports which one it found.
The verified column is read as `emailVerified`, or `email_verified` on a legacy
NextAuth table. Auth.js core stores no passwords, so its users arrive without
credentials.

**`betterauth` reads its schema before it queries.** It finds the tables
(`user` and `account`, or `users` and `accounts` under `usePlural: true`), how
the columns are spelled (camelCase, or the snake_case Better Auth's Drizzle
generator writes by default), and which plugin columns exist. The username
plugin adds `username`, admin adds `banned` (carried only while `banExpires` is
unset or in the future), phone-number adds `phoneNumber`, and so on; selecting a column that is not there fails the whole query, and the
database answers the question better than the user can. Passwords come from a
`LEFT JOIN` onto the credential `account` row — left, not inner, so a user who
only ever signed in with OAuth is still exported.

#### `firebase`

```sh
clerk migrate export firebase --service-account ./service-account.json
```

Create a key at **Project settings → Service accounts → Generate new private
key**. The account needs to read users and the project's password hash
parameters (`signIn.hashConfig`). Either of these works, both verified live:

- **Firebase Authentication Admin** (`roles/firebaseauth.admin`). The simplest
  option, but it can also modify users and auth settings.
- **Read-only:** Firebase Authentication Viewer (`roles/firebaseauth.viewer`)
  plus a custom role that adds `firebaseauth.configs.getHashConfig`:

  ```sh
  gcloud iam roles create clerkMigrateHashExport --project=PROJECT_ID \
    --title="Clerk migrate hash export" \
    --permissions=firebaseauth.configs.get,firebaseauth.configs.getHashConfig,firebaseauth.users.get
  gcloud projects add-iam-policy-binding PROJECT_ID \
    --member=serviceAccount:SA_EMAIL --role=roles/firebaseauth.viewer
  gcloud projects add-iam-policy-binding PROJECT_ID \
    --member=serviceAccount:SA_EMAIL --role=projects/PROJECT_ID/roles/clerkMigrateHashExport
  ```

Without `firebaseauth.configs.getHashConfig`, users still export, but the
export can't read the hash parameters. It says which permission is missing, and
the import then needs `--firebase-signer-key`, `--firebase-salt-separator`,
`--firebase-rounds` and `--firebase-mem-cost` (from **Authentication → Users →
⋮ → Password hash parameters** in the Firebase console).

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
Firebase emulator as well as production. The target line names the emulator
when it is set.

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
returning the first thousand would read as "that is everyone". It still exits
0, and `--json` carries `truncated: true`. A tenant of exactly 1000 gets the
warning too: Auth0 reports a larger tenant's total as 1000, so the two look the
same. The bulk job's NDJSON file imports as it is.

A credential the platform rejects (400, 401 or 403) is asked for again at a
terminal. An outage, a `429` or a refused connection is not: another
credential would not fix it, and it exits 1.

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

### `clerk migrate import`

Reads an exported user file, maps it onto Clerk's user schema, checks every
user against the destination instance, and creates them through the Backend
API.

```sh
clerk migrate import 20260929-141502-a1b2 --dry-run           # check, write nothing
clerk migrate import 20260929-141502-a1b2 --yes               # an export run
clerk migrate import users.json --source supabase --yes       # any other file
clerk migrate import users.json --source clerk --allow-partial --yes
clerk migrate import users.json --source clerk --new-run --yes
clerk migrate import users.json --source clerk --json --yes
clerk migrate import users.json --source clerk --require-password --yes
clerk migrate import users.json --source clerk --skip-legal-checks --yes
clerk migrate import users.json --source workos --reserve-unverified --yes
clerk migrate import users.json --source firebase --firebase-signer-key <key> \
  --firebase-salt-separator <sep> --firebase-rounds 8 --firebase-mem-cost 14 --yes
clerk migrate import users.json --source clerk --runs-dir ./runs --yes
clerk migrate import users.json --source clerk --app app_123 --instance prod --yes
clerk migrate import users.json --source clerk --secret-key sk_test_... -y
clerk migrate import                                          # a human is asked
```

| Flag                                    | Description                                                                                   |
| --------------------------------------- | --------------------------------------------------------------------------------------------- |
| `[file\|export-run-id]`                 | The export file, or the ID of the export run that wrote it                                    |
| `--source <key\|path>`                  | Where the file came from: a [source](#sources), or one you wrote                              |
| `--dry-run`                             | Run the [checks](#checks) against the instance, and write nothing                             |
| `--allow-partial`                       | Import the users that pass, and record the rest as skipped                                    |
| `--new-run`                             | Start a new run instead of [continuing](#re-running) an earlier one                           |
| `--require-password`                    | Import only users that carry a password digest                                                |
| `--skip-legal-checks`                   | Import users with no legal acceptance into an instance requiring it                           |
| `--reserve-unverified`                  | Create [unverified identifiers](#verified-vs-unverified-identifiers) reserved, not unverified |
| `--firebase-signer-key <key>`           | Firebase base64 signer key (overrides the export file)                                        |
| `--firebase-salt-separator <separator>` | Firebase base64 salt separator                                                                |
| `--firebase-rounds <n>`                 | Firebase scrypt rounds                                                                        |
| `--firebase-mem-cost <n>`               | Firebase scrypt memory cost                                                                   |
| `-y, --yes`                             | Import without prompting                                                                      |
| `--json`                                | Output as JSON. Never prompts, so importing needs `--yes`                                     |
| `--runs-dir <path>`                     | Where runs are kept (see [the run store](#the-run-store))                                     |

Plus the targeting flags from the table above: `--secret-key`, `--app` and
`--instance`.

An export run ID stands for the file that run wrote, and the import records it
as `fromExport`. A file `clerk migrate export` wrote carries its source, so it
needs no `--source`, and a `--source` that contradicts it exits 2. Any other
file needs `--source`: a JSON array, Firebase's own `{ "users": [...] }`, a CSV, or NDJSON, one user per line (what
Auth0's bulk export job writes). NDJSON is read always for `.ndjson` and
`.jsonl`, and for a `.json` file that doesn't parse whole. A leading BOM is
ignored in JSON and CSV. A file that isn't valid JSON is named in the error.

**What a human is asked, and what an agent is told.** A human at a terminal who
leaves out the file is asked for its path, and is asked for a source only when
the file does not name one. An agent, a non-TTY run, or `--json` without the
file, or without `--source` for a file that does not name one, exits 2 naming
what to pass.

**Nothing is written without consent.** After the checks, a human is asked
`Import N users?`, and declining writes nothing. `--yes` skips the question.
Without either — an agent, a non-TTY run, `--json` — the run prints the checks
and exits 2 with the exact command to run. Printed commands shell-quote their
paths, keep `--json`, and put `<key>` in place of a secret key.

**Every run prints its target first**, then which [case](#re-running) applies,
then the checks.

Failures do not stop the run: each user's outcome is written to the
[run](#the-run-store) and the import continues. A `429` backs off —
honouring `Retry-After` when the response carries it — and retries up to 5
times before the user is recorded as failed. The command exits 1 if any user
failed.

`--require-password` records each user it leaves out as `skipped`, so the run
ends `partial`.

`--json` returns `{ target, run, resume, checks, result }`. When a run stops
before importing, it carries one of `dryRun: true`, `refused: true`,
`consent: "required"` or `nothingToImport: true` in place of `result`, and a
file already imported in full returns `alreadyImported: true`.

#### Re-running

Running the same import again continues where it left off. The match is the
file's sha256, the source (and a custom source's content hash), and the
instance ID; the latest matching import run decides what happens:

| Latest match                              | Re-running does                                                        |
| ----------------------------------------- | ---------------------------------------------------------------------- |
| none                                      | a new run                                                              |
| interrupted (dead lock or no finish time) | continues the same run, skipping the users it created                  |
| `partial`                                 | continues the same run, retrying the users that failed or were skipped |
| `complete`                                | nothing: prints "Already imported in run …" and exits 0                |
| `undone`                                  | a new run                                                              |
| has an undo that did not finish           | exits 2, naming the `clerk migrate undo` that finishes it              |

`--new-run` skips the lookup. A run another live process holds exits 2.

A continued run also finishes what the last one left open:

- A user still `creating` is looked up by `external_id`. One Clerk holds is
  adopted as `created`, and not created again; one it doesn't is created.
- A user whose `created` line has `pending` identifiers gets just those
  attaches.

When an import completes, it names the folders it no longer needs: the export it
read, which holds your users' data, and its own run, which only `undo` needs.
Each comes with the `rm -rf` to remove it.

#### Checks

Every import runs the checks before writing anything, and `--dry-run` stops
after them. They sort the users three ways:

- **Rejected** — users Clerk would refuse. Each gets the first reason that
  applies:
  - it failed schema validation
  - its source requested a skip (Better Auth: an anonymous guest; Supabase: a
    soft-deleted user)
  - its only emails are ones Clerk refuses: malformed, or a domain that can't
    receive mail (`.local`, `.invalid`, `.test`, `.example`, `.arpa`,
    `.internal`, `.lan`, `.corp` and the like). Such an email is dropped from
    any other user, with a warning
  - it lacks an identifier the instance requires. An email or phone counts
    only when it is verified, because an unverified one is attached after the
    user exists, or with `--reserve-unverified`, which creates it reserved
  - it has no identifier left once those the instance has turned off are
    stripped
  - it lacks a first or last name the instance requires
  - it has an authenticator app secret or backup codes, and the instance has
    that turned off. Importing it without them would take away its second
    factor, so the checks offer to turn the setting on instead
  - it has no password, and password is the instance's only way to sign in
  - it has no legal acceptance on record, and the instance requires legal
    consent. `--skip-legal-checks`, or a yes at the prompt, imports these users
    without it (`skip_legal_checks`), with a warning
  - its username breaks the instance's username rules (length, letters,
    the allowed special characters)
  - its password is not the shape its hasher says (`bcrypt`, with a cost up to
    15, `scrypt_firebase`, `argon2i`/`argon2id` and `scrypt_werkzeug` are
    checked; other hashers are not, and Clerk refuses a bad one at create)
  - Supabase: its only providers are ones Clerk has off, or doesn't offer at all
    (Figma, Kakao, Keycloak, WorkOS, Zoom, Fly). The checks offer to turn on
    the first kind; nothing can turn on the second
  - its source ID, email, phone or username repeats an earlier user in the file
    that passes the checks above. Usernames compare case-insensitively and
    phones ignore punctuation. The first record in the file is kept, whatever
    either holds, and the reject names it (`kept: …`)
  - the instance already has a user with its source ID, email, phone or
    username (a batched `GET /v1/users` lookup, 100 values a request, through
    the scheduler). A user a continued run found behind its own interrupted
    create does not count
  - a development instance: it is past the 100-user headroom
    (`CLERK_MIGRATE_DEV_USER_LIMIT` when Clerk raised it), counted in file
    order
- **Imported, but not everything comes across** — fields the instance is not
  set up to store, fields Clerk has no place for (`Clerk won't store: …`),
  passwords a source had to drop, emails Clerk refuses (malformed, or a domain
  that can't receive mail), and names Clerk refuses (a phone number, URL or
  HTML: Better Auth's phone sign-up stores the number as the name).
- **Imported** — everyone else.

Any reject stops the import, and it exits 2 with the command that adds
`--allow-partial`. With `--allow-partial`, the rest import and each reject is
recorded as `skipped` with its reason. `--dry-run` exits 2 when the real run
would be refused, and 0 otherwise.

```
Checks
  120 users checked
  ✗ 12 users rejected
      12: only has an unverified email, and this instance requires an email
         u_17, u_22, u_40, u_51, u_88, and 7 more
  ⚠ Imported, but not everything comes across
      6 users have a username, which this instance is not set up to store
      Clerk won't store: department (120 users)
  ✓ 108 users to import

Or change the instance instead
  Make Email optional at sign-up
    clerk config patch --app app_… --instance ins_… --json '{"auth_email":{"required_for_sign_up":false}}'
  Enable Username
    clerk config patch --app app_… --instance ins_… --json '{"auth_username":{"used_for_sign_up":true}}'
```

Each fix names its instance with `--instance`, so it changes the instance the
import targets, whatever the key's source. When Clerk could not name the
instance (a `key_…` fallback ID), the fix points at the Dashboard instead: in
`--json` it carries `url` in place of `command`.

The fixes are offers, not corrections: an instance that requires an email is
configured as its owner intended, and fixing the export may be the answer. When
the instance settings cannot be read (BAPI `/v1/domains` → the instance's
Frontend API `/v1/environment`), required fields are not checked and the run
says so. When a development instance's user count cannot be read, the run says
so too, rather than checking the headroom against zero.

#### Sign-up restrictions

Every create sends `skip_restriction_checks: true`. The instance's allowlist,
blocklist, disposable-email and subaddress rules police new sign-ups, and these
users already signed up on the source platform.

#### Additional identifiers

Only the first verified email and phone go on `POST /v1/users`. Every
additional verified identifier, and every unverified one, is attached
afterwards with its own request, ahead of any create still queued, and backs
off on a `429` like the create. A refusal there is logged and the user still
counts as imported — a duplicate secondary email should not undo an otherwise
successful user. An attach with no answer stays `pending` for a re-run.

The first phone gets the same treatment when Clerk refuses it — a country the
instance does not support, or a number that is not E.164 — and the user has an
email: the create is retried without the phone, and the refusal is logged.

#### Throughput

Defaults follow Clerk's documented `POST /v1/users` limits: 100 req/s for
production instances, 10 req/s for development. Concurrency defaults to ~95% of
that, assuming ~100ms of API latency. Both are overridable:

| Variable                          | Effect                                                       |
| --------------------------------- | ------------------------------------------------------------ |
| `CLERK_MIGRATE_RATE_LIMIT`        | Requests per second                                          |
| `CLERK_MIGRATE_CONCURRENCY_LIMIT` | Concurrent in-flight requests                                |
| `CLERK_MIGRATE_DEV_USER_LIMIT`    | Development-instance user limit the checks use (default 100) |

A non-numeric or non-positive value is ignored in favour of the default.

A development instance's user limit is checked with the other
[checks](#checks): new development instances are created with a 100-user limit,
production instances have none, and the run reads the live count
(`GET /v1/users/count`). The limit itself is not served by any API, so for a
development instance Clerk has raised, set `CLERK_MIGRATE_DEV_USER_LIMIT` to
the raised limit; `--allow-partial` imports up to the headroom.

Users that do exceed the limit come back in the error breakdown as
`You have reached your limit of N users`, annotated with what a development
instance can do about it.

### `clerk migrate runs`

`runs` reads the [run store](#the-run-store).

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

### `clerk migrate undo`

Deletes the users an import run created. The import run is the whole record of
what to delete: every source ID whose latest line is `created`, by the Clerk ID
recorded beside it.

The one search is for a source ID whose latest line is `creating`: the run
stopped with that user's `POST /v1/users` sent and unanswered, so Clerk may
hold the user without its ID on record. Those are looked up by `external_id`.
The import's checks refused any source ID the instance already held, but a
later import of the same source IDs could have created one since. So a user
that another import run in the runs folder records as created is left out.

```sh
clerk migrate undo 20260929-141502-a1b2 --dry-run   # preview, delete nothing
clerk migrate undo 20260929-141502-a1b2             # confirms first
clerk migrate undo 20260929-141502-a1b2 --yes       # no prompt
clerk migrate undo 20260929-141502-a1b2 --json --yes
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
`last_sign_in_at`). When users remain to delete or record as gone, nothing is
deleted without consent: a yes at the prompt, or `--yes`. Without either — an
agent, a non-TTY run, or `--json` — it prints the preview and exits 2 with the
command to run. When none remain, undo completes without prompting.

It refuses with exit 2, and deletes nothing, when:

- the resolved key addresses a different instance than the run imported into
  (the error names both)
- the run is not an import run
- the run has already been undone

Deletes go through the same scheduler and `429` backoff as the import. A user
already gone from the instance counts as deleted. The undo is a run of its own,
`kind: "undo"` with `undoes: <id>`. The import is marked `undone` only when
every user is deleted. A partial undo exits 1, and running `undo` again retries
the users that failed, in the same undo run.

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

`sources` alone prints the table under [Sources](#sources). `sources <source>` shows one source in
full: its export command, what it carries with a note for each, where each
field lands (`encrypted_password → password`), its fixed defaults, and any
caveats. An unknown key exits 2 and lists the valid ones. There is no
intro/outro gutter: this reads a static registry rather than running anything.

### `clerk migrate help`

`clerk migrate help` and `clerk migrate <command> --help` print the help for the
group or one command, with examples. `clerk migrate help <command>` does the
same.

## Sources

A source maps one platform's export onto Clerk's user schema, and says what it
brings across. Adding a platform is one file in `sources/` plus one line in
`sources/registry.ts`; `--source`'s tab-completion reads from that array.

| Key          | Reads                         | Passwords | MFA     | Metadata |
| ------------ | ----------------------------- | --------- | ------- | -------- |
| `clerk`      | Clerk Dashboard export        | partial   | partial | partial  |
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

### Metadata

Metadata a user can edit on the source platform — Auth0's `user_metadata`,
Supabase's `raw_user_meta_data`, WorkOS's `metadata` — goes to Clerk's
`unsafe_metadata`, which is the user-editable one. Public metadata is read-only
to the user, so putting it there would take away an edit the user had. Auth0's
`app_metadata` goes to `private_metadata`. A Clerk Dashboard CSV carries no metadata.

### Better Auth passwords

Better Auth hashes with its own scrypt by default and lets an app swap in bcrypt
or argon2, so one database can hold more than one kind. The hasher is detected
per user:

| Stored value                | Sent as                                                    |
| --------------------------- | ---------------------------------------------------------- |
| `<32 hex>:<128 hex>`        | `scrypt:16384:16:1$<salt>$<key>`, hasher `scrypt_werkzeug` |
| `$2a$`, `$2b$` or `$2y$`    | `bcrypt`                                                   |
| `$argon2id$` or `$argon2i$` | `argon2id` or `argon2i`                                    |
| anything else               | dropped                                                    |

Better Auth's scrypt uses the hex salt string as the salt and a 64-byte key,
which is what `scrypt_werkzeug` verifies once N, r and p are written inline. It
also normalizes a password to NFKC before hashing, and Clerk does not, so a
password whose NFKC form differs will not verify and that user resets it.
`clerk migrate sources betterauth` lists that caveat.

A password Clerk cannot verify is **dropped, not rejected**: the user imports
without it and can sign in another way or reset it. Their run line carries
`passwordDropped: true`.

### Verified vs unverified identifiers

Every platform records verification differently, and each source declares
which style it uses. An identifier the source never confirmed is routed to
`unverifiedEmailAddresses` / `unverifiedPhoneNumbers` rather than the primary
field, because Clerk creates primary identifiers **verified** — sending an
unconfirmed address there would silently promote it.

- **Boolean** (`auth0`, `betterauth`, `firebase`, `workos`): `true`/`false`. A CSV export stringifies these, so `"false"` is
  read as false, not as a non-empty string. `TRUE`, `FALSE`, `t` and `f` read
  too, as a spreadsheet or psql writes them.
- **Timestamp** (`authjs`, `supabase`): a nullable confirmation time. Any real value
  means verified; `""`, `null` and `\N` do not.

A Clerk export keeps an unverified primary email or phone unverified.

**Unverified or reserved.** By default an unverified identifier is attached
after the user exists (`POST /v1/email_addresses`, `verified: false`). The user
cannot sign in with it, and another user can claim it by verifying it first.
`--reserve-unverified`, or a yes at the prompt a human gets when the file has
any, creates them **reserved** instead, on `POST /v1/users` through
`email_address_identification_status` / `phone_number_identification_status`.
A reserved identifier is unverified, but usable for sign-in and locked to the
user, and becomes verified the first time the user signs in with it. That is
how most source platforms treat an unconfirmed address, but it lets the user
sign in with one nobody proved they own, so it is opt-in. `-y`, `--json` and
agent mode never ask, and keep them unverified without the flag. A continued
run uses whichever the flag or answer says that time.

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

## Schema fields

What a source maps _onto_. Every user is validated against this schema
before any request is made, so a field a source produces that is not listed
here is silently dropped — Zod strips unknown keys — and never reaches Clerk.
Writing a custom source means targeting these names exactly.

The schema lives in `validator.ts`; adding a platform means adding a source,
not editing it.

**Required:** `userId` (`string`). It becomes the Clerk user's `external_id`,
which is what makes a migration re-runnable.

**Identifiers.** At least one of these must be present, or the import's checks
reject the user as invalid. Each accepts a single value or an array.

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
`md5_phpass`, `md5_salted`, `phpass`, `pbkdf2_sha1`, `pbkdf2_sha256`,
`pbkdf2_sha256_django`, `pbkdf2_sha512`, `pbkdf2_sha512_hex`, `scrypt_firebase`,
`scrypt_werkzeug`, `sha256`, `sha256_salted`, `sha512_symfony`

A user with an unrecognized hasher is rejected by the checks, naming the
hasher, like any other invalid user.

**Metadata.**

| Field             | Type     | Description                                              |
| ----------------- | -------- | -------------------------------------------------------- |
| `unsafeMetadata`  | `object` | Readable **and writable** by the client — never trust it |
| `publicMetadata`  | `object` | Readable by the client, writable only server-side        |
| `privateMetadata` | `object` | Server-side only                                         |

**Account state.** These are passed straight through to `POST /v1/users`, and
are how a Clerk-to-Clerk migration keeps original signup dates instead of
stamping every user with today's.

| Field                       | Type      | Description                                                                          |
| --------------------------- | --------- | ------------------------------------------------------------------------------------ |
| `createdAt`                 | `string`  | Original creation timestamp. A number is epoch milliseconds, or seconds below `1e11` |
| `legalAcceptedAt`           | `string`  | When legal terms were accepted                                                       |
| `banned`                    | `boolean` | Whether the user is banned                                                           |
| `bypassClientTrust`         | `boolean` | Skip client trust verification                                                       |
| `createOrganizationEnabled` | `boolean` | Whether the user can create orgs                                                     |
| `createOrganizationsLimit`  | `number`  | Maximum orgs the user can create                                                     |
| `deleteSelfEnabled`         | `boolean` | Whether the user can delete their account                                            |
| `skipLegalChecks`           | `boolean` | Skip legal acceptance checks                                                         |
| `skipPasswordChecks`        | `boolean` | Skip password requirements on import                                                 |

## API Endpoints

| Method   | Path                                            | Used by                                                                         |
| -------- | ----------------------------------------------- | ------------------------------------------------------------------------------- |
| `POST`   | `/v1/users`                                     | `migrate import` — creates each user                                            |
| `POST`   | `/v1/email_addresses`                           | `migrate import` — attaches additional emails                                   |
| `POST`   | `/v1/phone_numbers`                             | `migrate import` — attaches additional phones                                   |
| `GET`    | `/v1/users?limit=&offset=&order_by=+created_at` | `migrate export clerk` — pages the whole instance, oldest first, 500 at a time  |
| `GET`    | `/v1/users/count`                               | `migrate import` — headroom against a development instance's user limit         |
| `GET`    | `/v1/users?external_id=…`                       | `migrate import` — checks for users already in the instance, 100 values a call  |
| `GET`    | `/v1/users?external_id=…`                       | `migrate undo` — finds users whose create was in flight when the import stopped |
| `GET`    | `/v1/users?user_id=…`                           | `migrate undo` — reads the imported users back, 100 a call                      |
| `DELETE` | `/v1/users/{user_id}`                           | `migrate undo` — deletes one user                                               |
| `GET`    | `/v1/instance`                                  | `migrate import`, `undo`, `export clerk` — names the instance behind the key    |
| `GET`    | `/v1/domains`                                   | `migrate import` checks — resolves the Frontend API host                        |

The checks also read the instance's Frontend API `GET /v1/environment`
(bootstrapping a dev browser first on development instances) for its
attributes and enabled social providers. Nothing in `clerk migrate` writes
instance settings: the checks print the `clerk config patch` to run instead.

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

The three database exports (`supabase`, `authjs`, `betterauth`) connect over
`--db-url`. A `libsql://` URL is the one exception that goes over HTTP: it
posts to the server's pipeline endpoint.

## Notes

- `userId` in the source file becomes the Clerk user's `external_id`. That is
  what makes a migration re-runnable and reversible.
- CSV input is coerced before validation: `a@x.dev,b@x.dev` and `["a@x.dev"]`
  both become arrays, `"true"`/`1` become booleans, and JSON metadata columns
  are parsed. An empty column is dropped rather than sent as null.
- A user must end up with at least one identifier (email, phone or username).
  Users that do not are rejected by the checks as invalid.
