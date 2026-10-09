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
clerk migrate import <file> [--source <source>] [--dry-run] [--allow-partial] [--yes] [--json]
clerk migrate help
```

An import is usually two steps:

```sh
clerk migrate import users.json --source supabase --dry-run   # 1. check it against the instance
clerk migrate import users.json --source supabase --yes       # 2. import it
```

`--runs-dir <path>` (or `CLERK_MIGRATE_DIR`) keeps runs somewhere else.
`clerk migrate` on its own is a group name, not a command: it prints its help.

## The rules

Every command follows these:

1. **Nothing writes without consent.** Consent is a yes at a terminal prompt, or
   `--yes`. Without either, `import` prints what it would do and exits 2 with
   the command to run. `--json` means non-interactive: it never prompts.
2. **`--dry-run` checks against the real instance, and writes nothing.** An
   import's [checks](#checks) run before anything is written. Predicted
   rejects stop the import unless `--allow-partial` is passed; fields that would
   be dropped are warnings.
3. **State lives in one place: the [run store](#the-run-store).** Each run
   records its target, its file, and every source ID → Clerk ID outcome,
   including the error for each user who failed.
4. **Every command prints its target first:** the environment, app and
   instance, and where the key came from.
5. **Every subcommand takes `--json`.** Exit codes: `0` all good, `1` some users
   failed, `2` a usage error or a refusal, and `130` (death by SIGINT) when
   Ctrl-C stops an import partway. The UI goes to stderr and data to stdout.

   While users are created, a terminal shows a bar and the counts under it, not
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
instance, so `import` refuses (exit 2) an `--instance` that names a different
one. `--instance dev` next to an exported `sk_live_…` key would otherwise write
to production.

The **instance type is read from the key**: `sk_live_…` is treated as
production, anything else as development. That choice drives the throughput
defaults and the development-instance user limit below.

**Every command prints its target first.** `import` names the instance — its
environment, its app when the key came from one, and its ID from
`GET /v1/instance` — and where the key came from: `--secret-key`, `--app`, the
`CLERK_SECRET_KEY` env var, an accountless app's `.env.local`, or the linked
profile. `--json` carries the same facts as `target`.

```
Target: My App (app_2x9k…), production instance ins_2x9k…
Key from: linked profile
```

The instance ID is what a run records.

## The run store

Every import is a **run**, and the run store is the one place `clerk migrate`
keeps state.

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

A user's status is `creating`, `created`, `failed` or `skipped`. The last line
for each `sourceId` wins. A `429` retry, an extra email or phone that did not
attach, a first phone Clerk refused (which the summary also counts), and a
validation failure all land in the line's `error` field.

`creating` is written as a user's `POST /v1/users` goes out. It stays the
latest line when no answer says whether the create landed: an abort, a
network error, or a 5xx. A `created` line with `pending` lists the extra emails
and phones not yet attached.

A run is `partial` when any user failed, was skipped or is still `creating`,
and `complete` otherwise. A lock holding this process's own PID is stale: in a
container the CLI often gets the same PID every run.

Run folders are created owner-only (`0700`), because they hold user data.

`users.ndjson` writes are synchronous appends, so a run interrupted with Ctrl-C
still leaves a complete record of everything already processed. A line that
cannot be written stops that user's create from going out.

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

### `clerk migrate import`

Reads an exported user file, maps it onto Clerk's user schema, checks every
user against the destination instance, and creates them through the Backend
API.

```sh
clerk migrate import users.json --source supabase --dry-run   # check, write nothing
clerk migrate import users.json --source supabase --yes       # import
clerk migrate import users.json --source clerk --allow-partial --yes
clerk migrate import users.json --source clerk --json --yes
clerk migrate import users.json --source clerk --require-password --yes
clerk migrate import users.json --source clerk --skip-legal-checks --yes
clerk migrate import users.json --source clerk --runs-dir ./runs --yes
clerk migrate import users.json --source clerk --app app_123 --instance prod --yes
clerk migrate import users.json --source clerk --secret-key sk_test_... -y
clerk migrate import                                          # a human is asked
```

| Flag                  | Description                                                         |
| --------------------- | ------------------------------------------------------------------- |
| `[file]`              | A JSON or CSV export                                                |
| `--source <key>`      | Where the file came from: one of the [sources](#sources)            |
| `--dry-run`           | Run the [checks](#checks) against the instance, and write nothing   |
| `--allow-partial`     | Import the users that pass, and record the rest as skipped          |
| `--require-password`  | Import only users that carry a password digest                      |
| `--skip-legal-checks` | Import users with no legal acceptance into an instance requiring it |
| `-y, --yes`           | Import without prompting                                            |
| `--json`              | Output as JSON. Never prompts, so importing needs `--yes`           |
| `--runs-dir <path>`   | Where runs are kept (see [the run store](#the-run-store))           |

Plus the targeting flags from the table above: `--secret-key`, `--app` and
`--instance`.

A file is a JSON array, a CSV, or NDJSON, one user per line (what Auth0's bulk
export job writes). NDJSON is read always for `.ndjson` and `.jsonl`, and for a
`.json` file that doesn't parse whole. A leading BOM is ignored in JSON and
CSV. A file that isn't valid JSON is named in the error.

**What a human is asked, and what an agent is told.** A human at a terminal who
leaves out the file is asked for its path, and then for its source. An agent, a
non-TTY run, or `--json` without the file or `--source` exits 2 naming what to
pass.

**Nothing is written without consent.** After the checks, a human is asked
`Import N users?`, and declining writes nothing. `--yes` skips the question.
Without either — an agent, a non-TTY run, `--json` — the run prints the checks
and exits 2 with the exact command to run. Printed commands shell-quote their
paths, keep `--json`, and put `<key>` in place of a secret key.

**Every run prints its target first**, then the checks.

Failures do not stop the run: each user's outcome is written to the
[run](#the-run-store) and the import continues. A `429` backs off —
honouring `Retry-After` when the response carries it — and retries up to 5
times before the user is recorded as failed. The command exits 1 if any user
failed.

`--require-password` records each user it leaves out as `skipped`, so the run
ends `partial`.

`--json` returns `{ target, run, checks, result }`. When a run stops before
importing, it carries one of `dryRun: true`, `refused: true`,
`consent: "required"` or `nothingToImport: true` in place of `result`, with
`run: null`. With `--require-password`, `withoutPassword` counts the users it
left out before the checks, so `checks.total` plus it is the file's size.

#### Re-running

Running the same import again starts a new run. The users the first run
created are rejected as [already in the instance](#checks), so
`--allow-partial --yes` imports the rest. A user an interrupted run left at
`creating` is rejected the same way when Clerk holds it, and imported when it
doesn't.

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
  - it lacks an identifier the instance requires. An email or phone counts
    only when it is verified, because an unverified one is attached after the
    user exists
  - it has no identifier left once the emails and phones Clerk would refuse
    are stripped: those of an instance that neither has them on nor signs in
    or does MFA with them. A username is kept: Clerk stores it with usernames
    off
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
    it. With usernames off, such a username is dropped instead, with a warning
  - its password is not the shape its hasher says (`bcrypt`, with a cost up to
    15, `scrypt_firebase`, `argon2i`/`argon2id` and `scrypt_werkzeug` are
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
    the scheduler)
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
successful user. An attach with no answer stays `pending` on the user's line.

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
instance can do about it.

### `clerk migrate help`

`clerk migrate help` and `clerk migrate import --help` print the help for the
group or the command, with examples.

## Sources

A source maps one platform's export onto Clerk's user schema, and says what it
brings across. Adding a platform is one file in `sources/` plus one line in
`sources/registry.ts`; `--source`'s tab-completion reads from that array.

| Key        | Reads                        | Passwords | MFA     | Metadata |
| ---------- | ---------------------------- | --------- | ------- | -------- |
| `clerk`    | Clerk Dashboard export       | partial   | partial | partial  |
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

- **Boolean**: `true`/`false`. A CSV export stringifies these, so `"false"` is
  read as false, not as a non-empty string. `TRUE`, `FALSE`, `t` and `f` read
  too, as a spreadsheet or psql writes them.
- **Timestamp** (`supabase`): a nullable confirmation time. Any real value
  means verified; `""`, `null` and `\N` do not.

A Clerk export keeps an unverified primary email or phone unverified.

## Schema fields

What a source maps _onto_. Every user is validated against this schema
before any request is made, so a field a source produces that is not listed
here is dropped — Zod strips unknown keys — and never reaches Clerk. The checks
warn about each one (`Clerk won't store: …`).

The schema lives in `validator.ts`; adding a platform means adding a source,
not editing it.

**Required:** `userId` (`string`). It becomes the Clerk user's `external_id`.

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

| Method | Path                      | Used by                                                                        |
| ------ | ------------------------- | ------------------------------------------------------------------------------ |
| `POST` | `/v1/users`               | `migrate import` — creates each user                                           |
| `POST` | `/v1/email_addresses`     | `migrate import` — attaches additional emails                                  |
| `POST` | `/v1/phone_numbers`       | `migrate import` — attaches additional phones                                  |
| `GET`  | `/v1/users/count`         | `migrate import` — headroom against a development instance's user limit        |
| `GET`  | `/v1/users?external_id=…` | `migrate import` — checks for users already in the instance, 100 values a call |
| `GET`  | `/v1/instance`            | `migrate import` — names the instance behind the key                           |
| `GET`  | `/v1/domains`             | `migrate import` checks — resolves the Frontend API host                       |

The checks also read the instance's Frontend API `GET /v1/environment`
(bootstrapping a dev browser first on development instances) for its
attributes and enabled social providers. Nothing in `clerk migrate` writes
instance settings: the checks print the `clerk config patch` to run instead.

## Notes

- `userId` in the source file becomes the Clerk user's `external_id`.
- CSV input is coerced before validation: `a@x.dev,b@x.dev` and `["a@x.dev"]`
  both become arrays, `"true"`/`1` become booleans, and JSON metadata columns
  are parsed. An empty column is dropped rather than sent as null.
- A user must end up with at least one identifier (email, phone or username).
  Users that do not are rejected by the checks as invalid.
