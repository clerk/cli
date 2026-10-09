# `clerk migrate`

> **Experimental.** `clerk migrate` is hidden from help and completion, and
> refuses to run (exit 2, `experiment_disabled`), unless `CLERK_EXPERIMENTAL`
> includes `migrate`:
>
> ```sh
> CLERK_EXPERIMENTAL=migrate clerk migrate import --help
> ```
>
> `CLERK_EXPERIMENTAL` is a comma-separated list. Names are trimmed and
> case-insensitive, and unknown names are ignored.

Migrate users into a Clerk instance from another auth provider, or from another
Clerk instance.

```
clerk migrate export <source> [-o <path>] [--json]
clerk migrate import <file|export-run-id> [--source <source>] [--dry-run] [--allow-partial] [--new-run] [--yes] [--json]
clerk migrate runs [run-id] [--json]
clerk migrate undo <run-id> [--dry-run] [--yes] [--json]
clerk migrate help
```

A migration is usually three steps:

```sh
clerk migrate export supabase                         # 1. a run, holding export.json
clerk migrate import 20260929-141502-a1b2 --dry-run   # 2. check it against the instance
clerk migrate import 20260929-141502-a1b2 --yes       # 3. import it
```

`clerk migrate undo <run-id>` takes an import back out, and `clerk migrate runs`
shows what every run did. Every subcommand takes `--runs-dir <path>` (or
`CLERK_MIGRATE_DIR`) to keep its runs somewhere else.
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

## Targeting and auth

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

Every import, export and undo that gets as far as writing is a **run**, and the
run store is the one place `clerk migrate` keeps state. A dry run, a refusal, a
run that needs consent and an empty file write none (`run: null`). An import
whose users `--require-password` all leaves out still writes one, recording them
as skipped.

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
`exported`. The last line for each `sourceId` wins. A `429` retry, an extra
email or phone that did not attach, a first phone Clerk refused (which the
summary also counts), and a validation failure all land in the line's `error`
field.

`creating` is written as a user's `POST /v1/users` goes out. It stays the
latest line when no answer says whether the create landed: an abort, a
network error, or a 5xx. A `created` line with `pending` lists the extra emails
and phones not yet attached.

A run is `partial` when any user failed, was skipped, is still `creating` or
was never sent (`counts.notSent`), and `complete` otherwise. A run whose process
died, or that never recorded a finish time, lists as `interrupted`. A Ctrl-C
leaves a run that way. Its run ID and folder are printed as the run starts, so
they are on screen however it ends. A lock held by another live process refuses
a second writer with exit 2, and names the lock file to delete if that process
is not a migrate run. A lock holding this process's own PID is stale: in a
container the CLI often gets the same PID every run.

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
clerk migrate export supabase --db-url "postgres://postgres:...@db.xxx.supabase.co:5432/postgres"
clerk migrate export firebase --service-account ./service-account.json
```

The platform is an optional positional. Omitted, you get a picker built from
the registry; given, it runs directly. Each platform resolves its own flags —
what a Clerk export needs (a secret key) has nothing in common with what a
database export needs.

**A credential the far end rejects is asked for again.** Connection strings and
Firebase service account keys are long, pasted by hand, masked as they are
typed, and wrong in ways nothing local can check: a typo'd host, a revoked key,
an expired token, the right server but the wrong database. Only the connection
or the token exchange can say, and by then the operator has answered every
other question the command asked. So that step — and only that step,
never a fetch already under way or a file already written — runs inside a
retry: the failure is explained, the prompt comes back, and the rest of the
export continues against whichever credential worked. Agent mode and a non-TTY
fail outright instead, having nobody to ask, and `-y` fails too, having been
told not to.

| Platform   | Source                           | Feeds               |
| ---------- | -------------------------------- | ------------------- |
| `clerk`    | Clerk Backend API                | `--source clerk`    |
| `supabase` | Supabase Postgres (`auth.users`) | `--source supabase` |
| `firebase` | Firebase Identity Toolkit        | `--source firebase` |

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

| Flag                       | Platforms  | Description                                               |
| -------------------------- | ---------- | --------------------------------------------------------- |
| `-o, --output <path>`      | all        | Write the export here instead of the run folder           |
| `-y, --yes`                | all        | Do not prompt: fail on a bad credential                   |
| `--json`                   | all        | Print the result as JSON; never prompts                   |
| `--runs-dir <path>`        | all        | Where runs are kept (see [the run store](#the-run-store)) |
| `--db-url <url>`           | `supabase` | Postgres connection string                                |
| `--service-account <path>` | `firebase` | Path to a service account key JSON file                   |

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

#### Clerk exports no passwords

Clerk never returns password digests, TOTP secrets or backup codes over the API
— only the `*_enabled` booleans. Migrated users must reset their password in
the destination instance. The export says so on every run, and the coverage row
counts users who _have_ a password, so the size of the gap is visible up front.

#### `supabase` reads the database

```sh
clerk migrate export supabase --db-url "postgres://postgres:...@db.xxx.supabase.co:5432/postgres"
```

Supabase's database is Postgres, read through `Bun.sql`: any URL but
`postgres://` or `postgresql://` is refused before connecting. Nothing native
ships in the binary — that is the whole reason the `engines.bun` floor exists. Resolution is `--db-url`, then `SUPABASE_DB_URL`, then a masked
prompt, since a connection string carries the password inline. A password
pasted unencoded (`#`, `@`, `/` and the like) is percent-encoded for you.

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

**It reads the database rather than the Admin API** because
`encrypted_password` exists only there. An API-based export would force every
user to reset their password; this one carries the bcrypt digests across. It
also keeps `raw_app_meta_data`, which is what the import's
[checks](#checks) read for each user's providers.

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
clerk migrate import users.json --source firebase --firebase-signer-key SIGNER_KEY \
  --firebase-salt-separator SALT_SEPARATOR --firebase-rounds 8 --firebase-mem-cost 14 --yes
clerk migrate import users.json --source clerk --runs-dir ./runs --yes
clerk migrate import users.json --source clerk --app app_123 --instance prod --yes
clerk migrate import users.json --source clerk --secret-key sk_test_... -y
clerk migrate import                                          # a human is asked
```

| Flag                                    | Description                                                         |
| --------------------------------------- | ------------------------------------------------------------------- |
| `[file\|export-run-id]`                 | The export file, or the ID of the export run that wrote it          |
| `--source <key>`                        | Where the file came from: one of the [sources](#sources)            |
| `--dry-run`                             | Run the [checks](#checks) against the instance, and write nothing   |
| `--allow-partial`                       | Import the users that pass, and record the rest as skipped          |
| `--new-run`                             | Start a new run instead of [continuing](#re-running) an earlier one |
| `--require-password`                    | Import only users that carry a password digest                      |
| `--skip-legal-checks`                   | Import users with no legal acceptance into an instance requiring it |
| `--firebase-signer-key <key>`           | Firebase base64 signer key (overrides the export file)              |
| `--firebase-salt-separator <separator>` | Firebase base64 salt separator                                      |
| `--firebase-rounds <n>`                 | Firebase scrypt rounds                                              |
| `--firebase-mem-cost <n>`               | Firebase scrypt memory cost                                         |
| `-y, --yes`                             | Import without prompting                                            |
| `--json`                                | Output as JSON. Never prompts, so importing needs `--yes`           |
| `--runs-dir <path>`                     | Where runs are kept (see [the run store](#the-run-store))           |

Plus the targeting flags from the table above: `--secret-key`, `--app` and
`--instance`.

An export run ID stands for the file that run wrote: if that file is gone, or
has changed since (an `--output` path another export or an edit overwrote), the
import exits 2 and imports nothing. The import records it
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
paths, keep `--json`, and put `<key>` in place of a secret key and
`SIGNER_KEY`, `SALT_SEPARATOR`, `ROUNDS` and `MEM_COST` in place of the
Firebase parameters.

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
file already imported in full returns `alreadyImported: true`. With
`--require-password`, `withoutPassword` counts the users it left out before the
checks, so `checks.total` plus it is the file's size.

#### Re-running

Running the same import again continues where it left off. The match is the
file's sha256, the source, and the instance ID; the latest matching import run
decides what happens:

| Latest match                              | Re-running does                                                        |
| ----------------------------------------- | ---------------------------------------------------------------------- |
| none                                      | a new run                                                              |
| interrupted (dead lock or no finish time) | continues the same run, skipping the users it created                  |
| `partial`                                 | continues the same run, retrying the users that failed or were skipped |
| `complete`                                | nothing: prints "Already imported in run …" and exits 0                |
| `undone`                                  | a new run                                                              |
| has an undo that did not finish           | exits 2, naming the `clerk migrate undo` that finishes it              |

`--new-run` skips the lookup. A run another live process holds exits 2. When
Clerk cannot name the instance (`GET /v1/instance` failed, often from rate
limiting right after a large import) and a run of this file exists under a real
instance ID, it exits 2 rather than starting over: try again, or pass
`--new-run`. A continue whose run changed while it waited at the prompt, from
an undo or another continue, exits 2 too, with nothing written.

A continued run also finishes what the last one left open:

- A user still `creating` is looked up by `external_id`. A match that
  carries this run's marker is adopted as `created`, and not created again.
  A match without the marker is someone else's user: the checks reject that
  record as already in the instance. Only when the lookup finds no user at
  all is it created.

Every create sends the run's ID in the user's private metadata, as
`clerkMigrateRun`, merged with any private metadata the source carries. It
replaces a `clerkMigrateRun` the source already has, from a run that imported
the user into the source instance. It is how a cut-off create is told apart
from a user an app or another tool made with the same `external_id`, and it
stays on the user. A run recorded before the marker existed adopts nothing.

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
  - its source requested a skip (Supabase: a soft-deleted user)
  - its only emails are ones Clerk refuses: malformed, or a domain that can't
    receive mail (`.local`, `.invalid`, `.test`, `.example`, `.arpa`,
    `.internal`, `.lan`, `.corp` and the like). Such an email is dropped from
    any other user, with a warning
  - its only phones are not in E.164 form, and the instance has numeric
    usernames on, which makes Clerk require E.164. Such a phone is dropped from
    any other user, with a warning
  - it lacks an identifier the instance requires. An email or phone counts
    only when it is verified, because an unverified one is attached after the
    user exists
  - it has no identifier left once the emails and phones Clerk would refuse
    are stripped: those of an instance that neither has them on nor signs in
    or does MFA with them. A username is kept, as Clerk stores it with
    usernames off, unless it is one Clerk refuses
  - it lacks a first or last name the instance requires
  - it has an authenticator app secret or backup codes, and the instance has
    that turned off. Importing it without them would take away its second
    factor, so the checks offer to turn the setting on instead
  - it has no password, and password is the instance's only way to sign in
    (no code, link, social or SSO sign-in; a passkey or a password reset does
    not count, as in Clerk)
  - it has no legal acceptance on record, and the instance requires legal
    consent. `--skip-legal-checks`, or a yes at the prompt, imports these users
    without it (`skip_legal_checks`), with a warning
  - its username breaks the instance's username rules (length, letters,
    the allowed special characters). The checks offer the setting that allows
    it. With usernames off, such a username is dropped instead, with a warning.
    Numeric usernames are not offered when the file has phones not in E.164
    form, which the setting would make Clerk refuse; the reject counts them
  - its password is not the shape its hasher says (`bcrypt`, with a cost of 4
    to 15, `scrypt_firebase`, `argon2i`/`argon2id` and `scrypt_werkzeug` are
    checked; other hashers are not, and Clerk refuses a bad one at create)
  - Supabase: its only providers are ones Clerk has off, or doesn't offer at all
    (Figma, Kakao, Keycloak, WorkOS, Zoom, Fly), and it has no verified email or
    phone the instance signs in with by code or link. The checks offer to turn
    on the first kind; nothing can turn on the second
  - its source ID, primary email, primary phone or username repeats an
    earlier user in the file that passes the checks above. Only what the
    create sends counts: an extra email is attached after it, and a stripped
    one never goes out. Usernames compare case-insensitively and
    phones ignore punctuation. The first record in the file is kept, whatever
    either holds, and the reject names it (`kept: …`)
  - the instance already has a user with its source ID, email, phone or
    username (a batched `GET /v1/users` lookup, 100 values a request, through
    the scheduler). A user a continued run found behind its own interrupted
    create does not count
  - a development instance: it is past the 100-user headroom
    (`CLERK_MIGRATE_DEV_USER_LIMIT` when Clerk raised it), counted in file
    order
- **Imported, but not everything comes across** — emails or phones the
  instance is not set up to store, fields Clerk has no place for (`Clerk won't
store: …`), passwords a source had to drop, emails Clerk refuses (malformed,
  or a domain that can't receive mail), and names Clerk refuses (a phone
  number, a URL, HTML, blank, or over 256 bytes). A password, username or name
  whose setting is off is stored, and works or shows once it is turned on.
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
      6 users have a username, which this instance does not use: it is stored, and works only once usernames are turned on
      Clerk won't store: department (120 users)
  ✓ 108 users to import

Or change the instance instead
  Make Email optional at sign-up
    clerk config patch --app app_… --instance ins_… --json '{"auth_email":{"required_for_sign_up":false}}'
  Enable Username
    clerk config patch --app app_… --instance ins_… --json '{"auth_username":{"used_for_sign_up":true}}'
```

Each fix names its instance with `--instance`, so it changes the instance the
import targets, whatever the key's source. A key from `--secret-key` or
`CLERK_SECRET_KEY` names no app, so its fix reads `--app APP_ID`: fill in the
app that owns the instance. When Clerk could not name the
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
email: the create is retried without the phone. The user counts as imported,
and the summary lists them under "Imported without their phone", by Clerk's
reason (`result.warnings` in `--json`).

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
production instances have none by default (a plan can set one; the import
stops at the first refusal), and the run reads the live count
(`GET /v1/users/count`). The limit itself is not served by any API, so for a
development instance Clerk has raised, set `CLERK_MIGRATE_DEV_USER_LIMIT` to
the raised limit; `--allow-partial` imports up to the headroom.

Users that do exceed the limit come back in the error breakdown as
`You have reached your limit of N users`, annotated with what a development
instance can do about it. The first refusal stops the import: the users it
never sent are counted under "Not sent" (`result.notSent` in `--json`, and
`counts.notSent` in `run.json`). Once the limit is raised,
[run the import again](#re-running) to send them.

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
hold the user without its ID on record. Those are looked up by `external_id`,
and only a user carrying the import run's `clerkMigrateRun` marker is deleted:
an app or another tool can make a user with the same source ID, and one
without the marker is left alone.

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

### `clerk migrate help`

`clerk migrate help` and `clerk migrate <command> --help` print the help for the
group or one command, with examples. `clerk migrate help <command>` does the
same.

## Sources

A source maps one platform's export onto Clerk's user schema, and says what it
brings across. Adding a platform is one file in `sources/` plus one line in
`sources/registry.ts`; `--source`'s tab-completion reads from that array.

| Key        | Reads                        | Passwords | MFA     | Metadata |
| ---------- | ---------------------------- | --------- | ------- | -------- |
| `clerk`    | Clerk Dashboard export       | partial   | partial | partial  |
| `firebase` | `firebase auth:export`       | yes       | no      | no       |
| `supabase` | Supabase `auth.users` export | yes       | no      | partial  |

An unknown `--source` exits 2 with the list of valid keys.

There is no column for social sign-ins, because no source copies them and none
needs to. Enable the same providers in Clerk, and a user who signs in with one
is linked to their imported account by verified email. See
[account linking](https://clerk.com/docs/guides/configure/auth-strategies/social-connections/account-linking).

### Metadata

Supabase's `raw_user_meta_data`, which a user can edit on Supabase, goes to
Clerk's `unsafe_metadata`, which is the user-editable one. Public metadata is
read-only to the user, so putting it there would take away an edit the user
had. A Clerk Dashboard CSV carries no metadata.

### Verified vs unverified identifiers

Every platform records verification differently, and each source declares
which style it uses. An identifier the source never confirmed is routed to
`unverifiedEmailAddresses` / `unverifiedPhoneNumbers` rather than the primary
field, because Clerk creates primary identifiers **verified** — sending an
unconfirmed address there would silently promote it.

- **Boolean** (`firebase`): `true`/`false`. A CSV export stringifies these, so `"false"` is
  read as false, not as a non-empty string. `TRUE`, `FALSE`, `t` and `f` read
  too, as a spreadsheet or psql writes them.
- **Timestamp** (`supabase`): a nullable confirmation time. Any real value
  means verified; `""`, `null` and `\N` do not.

A Clerk export keeps an unverified primary email or phone unverified.

### Firebase hash parameters

Firebase uses a modified scrypt, so Clerk needs the project's four parameters
alongside each digest. Find them in the Firebase console under
**Authentication → Users → (⋮) → Password hash parameters**, and put them in
place of `SIGNER_KEY`, `SALT_SEPARATOR` and the two numbers:

```sh
clerk migrate import users.json --source firebase -y \
  --firebase-signer-key SIGNER_KEY --firebase-salt-separator SALT_SEPARATOR \
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
here is dropped — Zod strips unknown keys — and never reaches Clerk. The checks
warn about each one (`Clerk won't store: …`).

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

## API endpoints

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

`export firebase` talks to Google rather than to Clerk:

| Method | Path                                           | Used by                                              |
| ------ | ---------------------------------------------- | ---------------------------------------------------- |
| `POST` | `https://oauth2.googleapis.com/token`          | `export firebase` — RS256 assertion → access token   |
| `GET`  | `…/v1/projects/{project_id}/accounts:batchGet` | `export firebase` — pages users, 1000 at a time      |
| `GET`  | `…/admin/v2/projects/{project_id}/config`      | `export firebase` — reads the scrypt hash parameters |

The two Identity Toolkit paths are on `identitytoolkit.googleapis.com`, or on
`FIREBASE_AUTH_EMULATOR_HOST` when that is set.

## Notes

- `userId` in the source file becomes the Clerk user's `external_id`. That is
  what makes a migration re-runnable and reversible.
- CSV input is coerced before validation: `a@x.dev,b@x.dev` and `["a@x.dev"]`
  both become arrays, `"true"`/`1` become booleans, and JSON metadata columns
  are parsed. An empty column is dropped rather than sent as null.
- A user must end up with at least one identifier (email, phone or username).
  Users that do not are rejected by the checks as invalid.
