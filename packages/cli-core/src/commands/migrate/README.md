# `clerk migrate`

Migrate users into a Clerk instance from another auth provider, or from another
Clerk instance.

## Targeting And Auth

`migrate run` resolves its Backend API key through the CLI's standard chain:

| Flag                     | Description                                                      |
| ------------------------ | ---------------------------------------------------------------- |
| `--secret-key <key>`     | Use a specific Backend API secret key directly                   |
| `--clerk-secret-key <k>` | **Deprecated** alias for `--secret-key`; warns and keeps working |
| `--app <id>`             | Target an application directly, even outside a linked project    |
| `--instance <id>`        | Target `dev`, `prod`, or a full instance ID                      |

Resolution order: `--secret-key` → `--app` + Platform API lookup →
`CLERK_SECRET_KEY` → the keyless project's own key → a linked project profile
from `clerk link`.

The **instance type is read from the key**: `sk_live_…` is treated as
production, anything else as development. That choice drives the throughput
defaults and the hard development-instance cap below.

## Commands

### `clerk migrate` (interactive)

Bare `clerk migrate` dispatches to `migrate run`, which walks a human through
the migration instead of demanding flags — mirroring how bare `clerk deploy`
dispatches to `deploy run`.

```sh
clerk migrate
```

It picks the transformer from a list built off the registry, asks for the file,
collects Firebase's hash parameters when they are needed, and pre-fills the
platform and file from the last run so a repeat migration is mostly pressing
enter. Anything already passed as a flag is not asked for. Firebase's hash
parameters are never pre-filled — see [below](#--firebase--firebase).

Then it prints the [Migration Readiness report](#migration-readiness-report)
and waits for confirmation. Declining writes nothing to Clerk.

**Agent mode never prompts.** `clerk migrate` with no flags exits with a usage
error naming exactly what to pass:

```
`clerk migrate` is interactive and cannot prompt in agent mode.
Pass --transformer <platform> and --file <path>.
```

### `clerk migrate run`

Reads an exported user file, maps it onto Clerk's user schema, validates every
record, and creates the users through the Backend API.

```sh
clerk migrate run -y --transformer clerk --file users.json
```

| Flag                                    | Description                                                     |
| --------------------------------------- | --------------------------------------------------------------- |
| `-t, --transformer <name>`              | Source platform the file came from (see below)                  |
| `--transformer-file <path>`             | A transformer you wrote, for a platform with no built-in        |
| `-f, --file <path>`                     | Path to the export. `.json` or `.csv`                           |
| `-r, --resume-after <user-id>`          | Skip every user up to and including this **source** ID          |
| `--require-password`                    | Import only users that carry a password digest                  |
| `--skip-unsupported-providers`          | Supabase: skip users whose only social provider is off in Clerk |
| `--firebase-signer-key <key>`           | Firebase base64 signer key                                      |
| `--firebase-salt-separator <separator>` | Firebase base64 salt separator                                  |
| `--firebase-rounds <n>`                 | Firebase scrypt rounds                                          |
| `--firebase-mem-cost <n>`               | Firebase scrypt memory cost                                     |
| `-y, --yes`                             | Skip the confirmation prompt                                    |

Plus the targeting flags from the table above: `--secret-key`,
`--clerk-secret-key`, `--app` and `--instance`.

`--transformer` and `--file` are required. Omitting either fails with a usage
error that names the valid values.

Failures do not stop the run: each user's outcome is written to the log and the
import continues. A `429` backs off — honouring `Retry-After` when the response
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

**Development instances refuse imports over 500 users**, matching Clerk's own
limit — the run fails before any request is sent.

### `clerk migrate export`

Gets users **out** of a source platform, so there is something to feed
`migrate run`.

```sh
clerk migrate export                                    # pick a platform
clerk migrate export clerk --output users.json
clerk migrate export auth0 --domain my-tenant.us.auth0.com \
  --client-id … --client-secret …
```

The platform is an optional positional. Omitted, you get a picker built from
the registry; given, it runs directly. Each platform resolves its own flags —
what Auth0 needs (a tenant domain and M2M credentials) has nothing in common
with what a database export needs.

| Platform     | Source                           | Feeds                      |
| ------------ | -------------------------------- | -------------------------- |
| `clerk`      | Clerk Backend API                | `--transformer clerk`      |
| `auth0`      | Auth0 Management API             | `--transformer auth0`      |
| `supabase`   | Supabase Postgres (`auth.users`) | `--transformer supabase`   |
| `authjs`     | Auth.js database                 | `--transformer authjs`     |
| `betterauth` | Better Auth database             | `--transformer betterauth` |
| `firebase`   | Firebase Identity Toolkit        | `--transformer firebase`   |

Exports land at `./exports/<platform>-export.json` unless `--output` says
otherwise. `--output` resolves against the **current directory**, like every
other path flag here.

| Flag                       | Platforms                          | Description                                  |
| -------------------------- | ---------------------------------- | -------------------------------------------- |
| `-o, --output <path>`      | all                                | Where to write the export                    |
| `--db-url <url>`           | `supabase`, `authjs`, `betterauth` | Postgres, MySQL or SQLite connection string  |
| `--service-account <path>` | `firebase`                         | Path to a service account key JSON file      |
| `--domain <domain>`        | `auth0`                            | Tenant domain, e.g. `my-tenant.us.auth0.com` |
| `--client-id <id>`         | `auth0`                            | Machine-to-machine application client ID     |
| `--client-secret <secret>` | `auth0`                            | Machine-to-machine application client secret |

`export clerk` also takes the targeting flags — it reads from a Clerk instance,
so it resolves a key exactly the way `migrate run` does.

After each export you get a field-coverage table — which Clerk-relevant fields
were present on how many users — so you know the data is thin _before_ you
import it, not after:

```
Field coverage
  ● 3/3 have an email address
  ○ 0/3 have a phone number
  ○ 1/3 have a username
  ○ 2/3 have a password (not exportable — see below)

Exported 3 user(s) to /project/exports/clerk-export.json
Next: clerk migrate run --transformer clerk --file exports/clerk-export.json
```

Every export also writes `logs/export-<timestamp>.log`, so `migrate logs list`
sees it alongside imports and deletions.

#### Neither platform exports passwords

- **Clerk** never returns password digests, TOTP secrets or backup codes over
  the API — only the `*_enabled` booleans. Migrated users must reset their
  password in the destination instance.
- **Auth0**'s Management API does not return password hashes either; they come
  only from a support request. Add a `passwordHash` field to each user before
  importing, or migrate without passwords.

Both say so on every run. The coverage row counts users who _have_ a password,
so the size of the gap is visible up front.

#### Database-backed exports (`supabase`, `authjs`, `betterauth`)

These three read the database directly, over **`--db-url`**:

```sh
clerk migrate export supabase   --db-url "postgres://postgres:...@db.xxx.supabase.co:5432/postgres"
clerk migrate export authjs     --db-url "mysql://user:...@127.0.0.1:3306/authjs"
clerk migrate export betterauth --db-url "./db.sqlite"
```

Postgres and MySQL go through `Bun.sql`; SQLite through `bun:sqlite`. Both are
built into the runtime, so nothing native ships in the binary — that is the
whole reason the `engines.bun` floor exists. Resolution is `--db-url`, then
`SUPABASE_DB_URL` / `AUTHJS_DB_URL` / `BETTERAUTH_DB_URL`, then a masked prompt,
since a connection string carries the password inline.

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
Generate new private key**, with the Firebase Authentication Admin role. The
file is validated before anything reaches the network, so downloading the web
app config by mistake fails in a second with the right console page named
rather than after an auth round-trip. Key material never appears in output.

Firebase's scrypt is a modified variant, so a digest is worthless without the
project's four hash parameters. The export **reads them from the project** and
prints the exact import command:

```
Password hash parameters
Read from the project. Import with:
  clerk migrate run -y --transformer firebase --file exports/firebase-export.json \
    --firebase-signer-key "…" --firebase-salt-separator "…" \
    --firebase-rounds 8 --firebase-mem-cost 14
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

### `clerk migrate delete`

The undo for a bad migration. Deletes the users a previous `clerk migrate run`
created in this directory, matched by the `external_id` the import stamped on
each one.

```sh
clerk migrate delete        # confirms first
clerk migrate delete -y     # non-interactive
```

Takes the same targeting flags as `migrate run` (`--secret-key`, `--app`,
`--instance`).

Flat rather than under a noun group: it is the one command in this tree that
destroys data **in Clerk**, and is worth keeping short and prominent. (Contrast
`migrate logs clean`, which only removes local files.)

#### What it will and will not touch

The saved migration record is the only account of what a run created, so that
is what identifies the migration being undone. Without it the command fails and
explains — deleting nothing silently would look like a successful undo.

Users are found with `GET /v1/users?external_id=…`, 100 IDs per request. Only a
user Clerk itself reports as carrying one of _this_ migration's external IDs is
ever deleted; anything else in the instance is out of scope. IDs with no
matching user are skipped and reported, which is the normal case for a partial
migration or one already partly undone.

It confirms before acting — defaulting to **no** — and requires `-y` in
non-interactive or agent mode.

#### Failures

Rate limiting and 429 retries are literally the same code path as the import
(`lib/retry.ts`), not a second implementation that drifts.

A failure on one user is logged and the rest continue: a half-undone migration
with no record of which half is far worse than a reported failure. Every
attempt lands in a timestamped `logs/user-deletion-<timestamp>.log`, carrying
both the source ID and the Clerk ID. The command exits non-zero if any deletion
failed.

### `clerk migrate logs`

Everything that touches the local `./logs/` directory. Noun-verb like every
other group in the CLI (`config pull`, `users list`), rather than the standalone
tool's `clean-logs`/`convert-logs`, which were npm script names.

Grouping also disambiguates the two deletes in this tree: `migrate logs clean`
removes **local files**, `migrate delete` removes **users from a Clerk
instance**.

```sh
clerk migrate logs                  # defaults to list
clerk migrate logs list --json
clerk migrate logs clean -y
clerk migrate logs convert --all
clerk migrate logs convert migration-2026-01-01T12-00-00.log
```

| Subcommand     | Takes              | Description                                     |
| -------------- | ------------------ | ----------------------------------------------- |
| `logs list`    | `--json`           | Type, timestamp, size and entry count per file  |
| `logs clean`   | `-y, --yes`        | Delete the `.log` files in `./logs/`            |
| `logs convert` | `[file…]`, `--all` | NDJSON → a JSON array, written as `<name>.json` |

All three read the directory through one shared enumerator, which is what makes
`logs list` nearly free.

#### `logs list`

The default, because listing is read-only and therefore safe to run by
accident. Reports each file's type, timestamp, size and entry count, newest
first; `--json` gives an agent the same data without parsing NDJSON.

```
TYPE       TIMESTAMP            SIZE      ENTRIES
migration  2026-02-01T09-14-22  4.1 KB    120
deletion   2026-01-30T17-02-51  612 B     18
```

Says so plainly when `./logs/` is empty or absent.

#### `logs clean`

Destructive, so the confirmation is not optional: interactive runs prompt
(defaulting to **no**), and non-interactive or agent runs must pass `-y` rather
than being allowed to assume. Deletes `.log` files only — converted `.json`
output is left alone.

#### `logs convert`

Turns NDJSON into a JSON array for spreadsheet or database analysis, written
alongside the original as `<name>.json`. The original is left in place.

Takes file positionals or `--all`; given neither, an interactive terminal
offers a multiselect and an agent gets a usage error naming both alternatives.

A malformed line is reported with its line number and skipped, and the
remaining entries still convert:

```
migration-2026-01-01T12-00-00.log:2 is not valid JSON and was skipped — …
1 malformed line skipped.
```

That beats failing the whole file: a run killed mid-write leaves one truncated
final line, and the hundreds of complete entries before it are still worth
having. It also beats dropping the line silently, which would leave a JSON
array that looks complete.

## Transformers

A transformer maps one platform's export onto Clerk's user schema. Adding a
platform is one file in `transformers/` plus one line in `transformers/registry.ts` —
`--transformer`'s accepted values and its tab-completion both read from that array.

| Key          | Source                        | Passwords         | Notes                                                            |
| ------------ | ----------------------------- | ----------------- | ---------------------------------------------------------------- |
| `clerk`      | Clerk Dashboard export        | as exported       | Instance to instance, e.g. development → production              |
| `auth0`      | Auth0 Export Users API        | `bcrypt`          | Hashes need a support request to Auth0; not in a standard export |
| `authjs`     | Auth.js / NextAuth user table | none              | Assumes `SELECT id, name, email, email_verified, created_at`     |
| `betterauth` | Better Auth export            | `bcrypt`          | Reads the credential account's `password_hash`                   |
| `firebase`   | `firebase auth:export`        | `scrypt_firebase` | CSV or JSON; needs the four hash parameters below                |
| `supabase`   | Supabase `auth.users` export  | `bcrypt`          | Supports `--skip-unsupported-providers`                          |

### `clerk migrate transformers list`

Which mappings are available. New in the CLI: the standalone tool's interactive
picker was the only place these appeared, which was fine when the user had the
source tree to grep. A compiled binary's users have neither.

```sh
clerk migrate transformers list
clerk migrate transformers list --json
clerk migrate transformers list --transformer-file ./my-transformer.ts
```

| Flag                        | Description                       |
| --------------------------- | --------------------------------- |
| `--json`                    | Output as JSON                    |
| `--transformer-file <path>` | Also list a transformer you wrote |

`--json` gives an agent the same data, including which source field each
transformer maps to `userId`.

### `clerk migrate settings`

What a run in this directory would pick up, and where each value comes from.

```sh
clerk migrate settings                                     # list
clerk migrate settings set transformer firebase
clerk migrate settings set firebase-signer-key abc123…
clerk migrate settings clear -y
```

```
SETTING                     VALUE      SOURCE
transformer                 firebase   clerk config
file                        ./users.json  clerk config
firebase-signer-key         aVer…3456  .env.clerk-migrate
firebase-rounds             —          not set
```

The source column is the point. A migration reads from flags, the environment,
two of the app's env files and the CLI's config, so when a run picks up a stale
value the question is never "what is it" but "which of those won".

| Command                       | Description                                           |
| ----------------------------- | ----------------------------------------------------- |
| `settings` / `settings list`  | Show every setting, its value and its source          |
| `settings list --json`        | The same, machine-readable                            |
| `settings set <name> <value>` | Change one setting                                    |
| `settings clear [-y]`         | Forget this project's settings and delete its secrets |

#### Where each setting is kept

Two stores, split by what the value **is** rather than by which command wrote it:

| Store                | Holds                                               | Why                                                              |
| -------------------- | --------------------------------------------------- | ---------------------------------------------------------------- |
| CLI config           | `transformer`, `file`, `skip-unsupported-providers` | Project state, not secret, useless outside the CLI               |
| `.env.clerk-migrate` | `firebase-*`                                        | Credentials: gitignored on write, and hand-editable for rotation |

`.env.clerk-migrate` is the migration's own file rather than the app's
`.env.local`, because a Firebase signer key is of no use to the application
being migrated and does not belong in the file its developers read daily. The
CLI adds it to `.gitignore` the first time it writes it, and deletes it when
`settings clear` removes the last value.

Credentials are redacted wherever they are displayed, including under `--json`,
so the output is safe to paste into an issue.

### Custom transformers (`--transformer-file`)

Migrating from a platform with no built-in, without recompiling the CLI:

```sh
clerk migrate run --transformer-file ./my-platform.ts --file users.json
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
  defaults: { passwordHasher: "bcrypt" },
  postTransform: (user) => {
    if (!user.firstName) delete user.firstName;
  },
};
```

TypeScript is fine — Bun's transpiler is part of the runtime, so `interface`,
`satisfies` and `as const` all work in a file the compiled binary imports.
Plain `.js` works too.

`--transformer-file` and `--transformer` together is an error: both name a
transformer and there is no sensible precedence between the one you wrote and
the one we ship.

#### Validation

The file is code the CLI executes, so its shape is checked before use and
rejected with the specific problem rather than crashing mid-pipeline:

| Problem                            | Message                                                                                              |
| ---------------------------------- | ---------------------------------------------------------------------------------------------------- |
| Path does not exist                | `No transformer file at /abs/path.ts.`                                                               |
| No default export, but a named one | ``has no default export. Found named export `myPlatform` — did you mean `export default`?``          |
| Does not parse                     | `Could not load ./f.ts: Expected identifier but found ","`                                           |
| Nothing maps to `userId`           | ``no source field maps to `userId`. Every user needs one — it becomes the Clerk user's external_id`` |
| `key` clashes with a built-in      | `key is "clerk", which is already a built-in transformer`                                            |
| A hook is not a function           | `postTransform must be a function when present`                                                      |

The `userId` check is the load-bearing one: without it the import would run to
completion and create every user with no `external_id`, which is what makes a
migration re-runnable and what `migrate delete` matches on.

### Verified vs unverified identifiers

Every platform records verification differently, and each transformer declares
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
clerk migrate run -y -t firebase -f users.json \
  --firebase-signer-key <key> --firebase-salt-separator <sep> \
  --firebase-rounds 8 --firebase-mem-cost 14
```

All four are **required as a set** — supplying some but not all is a usage error
naming what is missing. A partial set produces a well-formed digest that
verifies against nothing, so users would import successfully and then be unable
to sign in.

They never go into the CLI's config: the signer key is a Firebase secret, and
that file is not a secret store. To avoid re-passing all four on every run, set
them once with [`clerk migrate settings`](#clerk-migrate-settings), or export
them yourself:

| Variable                        | Flag                        |
| ------------------------------- | --------------------------- |
| `CLERK_FIREBASE_SIGNER_KEY`     | `--firebase-signer-key`     |
| `CLERK_FIREBASE_SALT_SEPARATOR` | `--firebase-salt-separator` |
| `CLERK_FIREBASE_ROUNDS`         | `--firebase-rounds`         |
| `CLERK_FIREBASE_MEM_COST`       | `--firebase-mem-cost`       |

Resolution order is flag, then exported variable, then `.env.clerk-migrate`,
then the app's `.env.local`/`.env`. The sources can be mixed as long as all four
end up supplied. Run with `--verbose` to see which one each came from.

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

What a transformer maps _onto_. Every user is validated against this schema
before any request is made, so a field a transformer produces that is not listed
here is silently dropped — Zod strips unknown keys — and never reaches Clerk.
Writing a custom transformer means targeting these names exactly.

The schema lives in `validator.ts`; adding a source platform means adding a
transformer, not editing it.

**Required:** `userId` (`string`). It becomes the Clerk user's `external_id`,
which is what makes a migration re-runnable and what `migrate delete` matches on.

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
flags the two failure modes a migration otherwise discovers halfway through:

- **Required in Clerk, missing from the file.** Those users fail one at a time,
  mid-import, after earlier users already exist.
- **Present in the file, disabled in Clerk.** Social providers users actually
  signed up with, or an identifier the instance has switched off.

```
Migration readiness
  120 users ready to import
  3 failed validation and will be skipped

Identifiers
  ⚠ Email — required in Clerk, but 12 users lack it — 108/120 users
  ✓ Username — enabled in Clerk — all users

Social connections
  ✓ Google — enabled in Clerk — 40/120 users
  ⚠ Discord — not enabled in Clerk — 12/120 users

⚠ 2 settings need attention
```

If the instance settings cannot be read — the secret key is rejected, or FAPI
is unreachable — the report degrades to a coverage-only listing with a note.
Nothing is flagged in that case: "could not read" is not the same as "switched
off", and treating it as such would raise alarms about settings that are
perfectly fine.

## Artifacts

Both are written relative to the **current working directory**, not to the
CLI's config directory, because they describe "which file am I migrating"
rather than "which project is linked here".

| Path                                   | Contents                                                              |
| -------------------------------------- | --------------------------------------------------------------------- |
| `./logs/migration-<timestamp>.log`     | NDJSON: one line per user, plus validation failures and retry notices |
| `./logs/user-deletion-<timestamp>.log` | NDJSON: one line per `migrate delete` attempt                         |
| `./logs/export-<timestamp>.log`        | NDJSON: one line per exported user                                    |
| `./exports/<platform>-export.json`     | The export itself, unless `--output` says otherwise                   |
| `./.env.clerk-migrate`                 | Migration credentials, written by `settings set` and gitignored       |

The transformer and file of the last run are **not** written here. They go to
the `migrations` section of the CLI's own config file, keyed by project the
same way a linked profile is. That is what `migrate delete` reads to know which
migration to undo, so it is load-bearing rather than a convenience — and it has
no business being written into the repository being migrated.

Log writes are synchronous appends, so a run interrupted with Ctrl-C still
leaves a complete record of everything already processed. Use the last
successful `userId` in that log with `--resume-after` to continue.

### Why the logs are NDJSON

One JSON object per line, rather than one JSON array per file. A migration is a
long append-only stream, and that format is the one that survives it:

- **Appendable.** Each entry is written as it happens, without rewriting the
  file. A JSON array would have to be re-serialized on every user.
- **Crash-safe.** Kill the process at any point and every line already written
  is still valid. A truncated array is not parseable at all.
- **Streamable.** `tail -f` shows a long import progressing live, and analysis
  reads line by line instead of loading a million-user log into memory.

Which is also why it greps usefully without any tooling:

```sh
grep '"status":"success"' logs/migration-2026-01-01T12-00-00.log | wc -l
grep '"userId":"user_123"' logs/migration-2026-01-01T12-00-00.log
```

The trade-off is that spreadsheets, databases and most JSON tooling want an
array. That is what `clerk migrate logs convert` is for — convert when you need
to open a log in Excel or hand it to someone who should not have to know what
NDJSON is. The original `.log` stays put.

## API Endpoints

| Method   | Path                       | Used by                                                                              |
| -------- | -------------------------- | ------------------------------------------------------------------------------------ |
| `POST`   | `/v1/users`                | `migrate run` — creates each user                                                    |
| `POST`   | `/v1/email_addresses`      | `migrate run` — attaches additional emails                                           |
| `POST`   | `/v1/phone_numbers`        | `migrate run` — attaches additional phones                                           |
| `GET`    | `/v1/users?external_id=…`  | `migrate delete` — finds this migration's users, 100 IDs a call                      |
| `GET`    | `/v1/users?limit=&offset=` | `migrate export clerk` — pages the whole instance, 500 at a time                     |
| `DELETE` | `/v1/users/{user_id}`      | `migrate delete` — removes one user                                                  |
| `GET`    | `/v1/domains`              | Readiness report and `--skip-unsupported-providers` — resolves the Frontend API host |

Two exports talk to their own platform rather than to Clerk:

| Method | Path                                           | Used by                                              |
| ------ | ---------------------------------------------- | ---------------------------------------------------- |
| `POST` | `https://<tenant>/oauth/token`                 | `export auth0` — Management API access token         |
| `GET`  | `https://<tenant>/api/v2/users`                | `export auth0` — 100 per page, 1000 users maximum    |
| `POST` | `https://oauth2.googleapis.com/token`          | `export firebase` — RS256 assertion → access token   |
| `GET`  | `…/v1/projects/{project_id}/accounts:batchGet` | `export firebase` — pages users, 1000 at a time      |
| `GET`  | `…/admin/v2/projects/{project_id}/config`      | `export firebase` — reads the scrypt hash parameters |

The two Identity Toolkit paths are on `identitytoolkit.googleapis.com`, or on
`FIREBASE_AUTH_EMULATOR_HOST` when that is set.

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
