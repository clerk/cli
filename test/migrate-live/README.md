# Live migrate tests

End-to-end tests of `clerk migrate` against real provider accounts and real
Clerk instances. They run this checkout's CLI
(`packages/cli-core/src/cli.ts`), so a run tests the code next to it.

They never run in PR CI: `bun run test` and `bun run test:e2e` don't scan
this folder, and nothing here ends in `.test.ts`. They run locally, and once a
week in `.github/workflows/migrate-live.yml`.

Ported from `migration-test-apps` (`royanger/clerk-migrate-e2e-tests`), which
still owns the generators: `data/users.json`, `data/users-10k.json`, the
custom exports and the answer keys are copied from there. The slice tests and
the evals stay there too.

> [!IMPORTANT]
> Agents must not read `data/custom-sources-answers/`. It holds the answer
> keys the evals in `migration-test-apps` grade against.

## Run

From the repo root:

```sh
bun run test:migrate-live -p better-auth -v B0   # quickest full check: 100 users, all must land
bun run test:migrate-live -p better-auth         # every Better Auth variation
bun run test:migrate-live:all                    # every provider, then BK1K and BK (about 1.5–2 hours)
bun run test:migrate-live:custom                 # the 12 custom-source exports, each must grade A+
bun run test:migrate-live:teardown               # empty a Clerk instance a run left behind
```

Each script runs `scripts/run-migrate-live-op.ts`, which reads the secrets
from 1Password with `op run` and runs the test from this folder. Nothing is
written to disk. You need the 1Password CLI with the desktop app integration
on, and access to the vault the script names in `OP_VAULT`.

Without 1Password, export the env vars yourself and run from this folder:
`bun test-migrate.ts -p better-auth -v B0`, `bash test-all.sh`,
`bun test-custom-source.ts --all --sources-dir data/custom-sources-answers`.
That's what CI does.

Results land in `test-results/` and `clerk-runs/` here (both gitignored).

## Env vars

1Password item `Clerk CLI - Migration test creds`. Each field is the env var
name with a `MIGRATION_LIVE_TESTS_` prefix, in the `Testing creds` section;
the two Firebase service accounts are in `Service Accounts`. In CI, each is a
secret of the `migrate-live` GitHub Environment with the same prefixed name.

| Group                                                                | Env vars                                                                                                       |
| -------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| Clerk `dev` target                                                   | `CLERK_MIGRATE_TESTS_1_SECRET_KEY`, `CLERK_MIGRATE_TESTS_1_APP_ID`                                             |
| Clerk `pool-1` target                                                | `CLERK_POOL_1_SECRET_KEY`, `CLERK_POOL_1_APP_ID` (not set up yet)                                              |
| Clerk eval source (checked so a pool target isn't the same instance) | `CLERK_SOURCE_SECRET_KEY`, `CLERK_EVALS_SOURCE_APP_ID`                                                         |
| Clerk 10K                                                            | `CLERK_SECRET_KEY_10K_DEV`, `CLERK_SECRET_KEY_10K_PROD`                                                        |
| Clerk Platform API (CI only; locally `clerk auth login`)             | `CLERK_PLATFORM_API_KEY`                                                                                       |
| Turso                                                                | `BA_TURSO_DATABASE_URL`, `BA_TURSO_DATABASE_TOKEN`, `AUTHJS_TURSO_DATABASE_URL`, `AUTHJS_TURSO_DATABASE_TOKEN` |
| Auth0                                                                | `AUTH0_DOMAIN`, `AUTH0_CLIENT_ID`, `AUTH0_CLIENT_SECRET`                                                       |
| Supabase                                                             | `NEXT_PUBLIC_SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_CONNECTION_STRING`, `SUPABASE_ACCESS_TOKEN` |
| Firebase                                                             | `FIREBASE_SERVICE_ACCOUNT_JSON`, `FIREBASE_SERVICE_ACCOUNT_JSON_HASH_ROLE` (F1H)                               |
| WorkOS                                                               | `WORKOS_API_KEY`                                                                                               |

1Password is the source of truth. After changing a value there, update the
matching `migrate-live` environment secret too:

```sh
op read "op://<vault>/Clerk CLI - Migration test creds/Testing creds/MIGRATION_LIVE_TESTS_<NAME>" |
  gh secret set MIGRATION_LIVE_TESTS_<NAME> --env migrate-live --repo clerk/cli
```

## CI

`.github/workflows/migrate-live.yml` runs the full suite every Monday at 09:17
UTC and posts to Slack when a scheduled run fails. Run it by hand from the
Actions tab (`workflow_dispatch`), for every provider or just one. It only
runs from `main`: the `migrate-live` environment, which holds the secrets,
rejects every other branch. Reports are uploaded as the `migrate-live-results`
artifact for 7 days.

## Flags

**test:migrate-live** (`test-migrate.ts`)

| Long                  | Short | Means                                                           |
| --------------------- | ----- | --------------------------------------------------------------- |
| `--provider <name>`   | `-p`  | the provider to test                                            |
| `--variation <id>`    | `-v`  | run one test by its ID ([Test IDs](#test-ids))                  |
| `--dest <D1…D5\|all>` | `-d`  | the Clerk config to import into ([Dests](#dests))               |
| `--target <name>`     | `-t`  | the Clerk instance to import into ([Targets](#targets))         |
| `--cli <path>`        |       | run a local Clerk CLI checkout                                  |
| `--users-file <path>` |       | seed every user in that file, skipping the variation's own pick |
| `--export-to <path>`  |       | export only: save the export file and stop before the import    |
| `--seed-only`         |       | seed through `-v`'s setup and leave the users in the provider   |
| `--restore-source`    |       | empty the provider and put its standard users back              |

**test:migrate-live:teardown**

| Long                  | Short       | Means                                                                                              |
| --------------------- | ----------- | -------------------------------------------------------------------------------------------------- |
| `--app <id>`          | `-a`        | skip the picker and use that app's development instance                                            |
| `--production`        | `-p`        | production: with `-a`, that app's; alone, a picker of production instances                         |
| `--all`               |             | every "Migration Testing - " instance (with `-p`, every production one); same as `a` in the picker |
| `--yes` / `--dry-run` | `-y` / `-n` | delete for real / report only                                                                      |
| `--cli <path>`        |             | run a local Clerk CLI checkout                                                                     |

**test-custom-source.ts** (`test:migrate-live:custom` passes
`--all --sources-dir data/custom-sources-answers`)

Paths in these flags are relative to `test/migrate-live/`, where every script
runs.

| Long                            | Short | Means                                                                            |
| ------------------------------- | ----- | -------------------------------------------------------------------------------- |
| `--export <name.fmt>`           | `-e`  | the export to import, e.g. `keyhole.csv`                                         |
| `--source <path>`               | `-s`  | the custom source to import it with                                              |
| `--all` + `--sources-dir <dir>` |       | every export; finds `<name>-<fmt>.ts`, else `<name>.ts`, in the folder           |
| `--out <dir>`                   | `-o`  | write the report to `<dir>/test-custom` and the CLI's runs to `<dir>/clerk-runs` |

## Migration tests

Each test seeds a source with known users, exports them with
`clerk migrate export`, and imports them into a Clerk instance with
`clerk migrate import`. It then compares what Clerk holds with what the seed
says should be there, and undoes the import. A test starts and ends with an
empty Clerk instance.

```sh
bun run test:migrate-live:all                         # everything (about 1.5–2 hours)
bun run test:migrate-live -p better-auth              # every variation, each on its own dests
bun run test:migrate-live -p better-auth -v B0        # one variation
bun run test:migrate-live -p better-auth -v B0 -d all # against D1–D5
bun run test:migrate-live -p better-auth --target 10k-prod
bun run test:migrate-live ... --cli <path/to/cli.ts>  # a different CLI checkout
```

Each variation and dest pair runs the same loop:

1. Set the source's config (connection, tables, plugins), reset it and seed it.
2. Run `clerk migrate export` against the source, then empty the source.
3. Patch the Clerk instance to the dest config.
4. Dry run, import, check what Clerk holds, then undo.

The runner snapshots the Clerk config first and restores it at the end. The
Clerk instance has to start empty. If it isn't, run `bun run test:migrate-live:teardown`.

### What every test checks

- **The dry run matches the import.** The number of users the dry run calls
  importable must equal the number created, with none failing at import time.
- **What Clerk holds matches the seed.** The runner counts users, passwords,
  usernames, phones, verified emails and bans in Clerk, and compares them with
  what the source can carry. Auth0 and WorkOS never export password hashes, so
  their tests expect 0 passwords.
- **Imported passwords work.** The runner checks each password with Clerk's
  `verify_password` and the seed password. Past 500 users, it checks a spread
  sample of 200.
- **Undo leaves the instance empty.** After `clerk migrate undo`, the instance
  must hold 0 users again.

Some tests add their own checks: how names split (J7), which metadata bucket
holds what (A7, C6, W4), external IDs (A4, A5, A7, W5), verified emails read
from a renamed column (J6), or an export that must refuse the source's schema
(B10).

### Expected failures

These tests set out to make the CLI refuse users, and check that it refuses
the right ones.

**Exact rejects per Clerk config (B9).** The runner compares the users the dry
run rejected with the users that config must reject, and checks each reason. A
user rejected by mistake, a user the dry run should have rejected, or a wrong
reason fails the test.

| Dest | Must reject                                                                                                                         |
| ---- | ----------------------------------------------------------------------------------------------------------------------------------- |
| D1   | nobody                                                                                                                              |
| D2   | users without a verified real email (an `@phone.local` placeholder doesn't count), or with a username outside Clerk's default rules |
| D3   | users without a verified phone, or with a bad username                                                                              |
| D4   | users without a username, or with a bad username                                                                                    |
| D5   | users without a verified real email. D5 turns phone and username off, so the CLI drops those fields and keeps the user              |

**Deliberate failures (X1–X5, Better Auth source).**

| ID  | Scenario                                                | Must happen                                                                                 |
| --- | ------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| X1  | password required (D2), half the users have none        | nobody rejected; a "without a password, which this instance requires" warning; all imported |
| X2  | `--require-password`                                    | the CLI leaves out users without a password                                                 |
| X3  | an email, a phone and a username already taken in Clerk | the CLI rejects those 3 users and no others, each "already used / already taken"            |
| X4  | 1 user already in the dev instance, 100 to import       | the CLI rejects 1 user, for the 100-user limit                                              |
| X5  | the same export imported twice                          | "already imported", and nothing added                                                       |

### Results

Each test run writes to two folders with the same name,
`<timestamp>-<provider>-<target>`. A batch puts its runs in one folder stamped
when it started: `bun run test:migrate-live:all` in `<timestamp>-all/`, with a
`summary.md` of each run's result.
Each run is a `<provider>-<target>/` sub-folder there, in both places:

| Folder                | What's in it                                                                                                                                                     |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `test-results/<run>/` | `report.md` and `report.json` (one row per test), `log.txt`, the Clerk config snapshot, and per test its seed file, dry run, import and Clerk summary            |
| `clerk-runs/<run>/`   | the Clerk CLI's own run store (`--runs-dir`): each `export.json`, `users.ndjson` and `run.json`. `report.json` names the export and import run IDs for each test |

Git ignores both folders, because the export files hold the seeded users and
their password hashes. You can delete them at any time: each test undoes its
own import.

### Before a long run

- **1Password:** each `bun run test:migrate-live*` asks once, for the whole run.
- **Supabase:** free projects pause after a week idle. `test:migrate-live:all`
  wakes the project first. For a single run, restore it from the dashboard if
  the tests time out on SQL.
- **Clerk dev instance:** Clerk caps it at 100 users, so tests on the `dev`
  target use 100 or fewer. BK1K and BK run on the raised-limit and production
  instances.
- **Auth0 free tier:** the Management API allows about 2 requests a second.
  Each Auth0 test creates a temporary connection and deletes it afterwards;
  Auth0 then removes that connection's users on its side.

### Test IDs

Each test has a short ID that starts with its provider's letter. `-v <id>` runs
that test; leave `-v` off to run all of a provider's tests.
[Every test](#every-test) has the full descriptions.

| Provider (`-p`) | IDs                                 |
| --------------- | ----------------------------------- |
| `auth0`         | A1–A7                               |
| `authjs`        | J1–J7                               |
| `better-auth`   | B0, BP, BI, B1–B10, X1–X5, BK1K, BK |
| `clerk`         | C1–C6                               |
| `firebase`      | F1, F1H, F2–F8                      |
| `supabase`      | S1–S8                               |
| `workos`        | W1–W7                               |

For the quickest full check, run `bun run test:migrate-live -p better-auth -v B0`: 100
users, the seeded schema and D1, and all 100 must land in Clerk.

### Dests

The Clerk instance configs the tests import into. D1 is the default.

| Dest | Clerk config                                                                               | What it exercises                                                                                 |
| ---- | ------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------- |
| D1   | email, phone, username and password all on, nothing required; extended username characters | every valid user imports                                                                          |
| D2   | email and password required                                                                | the CLI rejects users without a verified email; passwordless users import with a warning          |
| D3   | phone required                                                                             | the CLI rejects email-only users                                                                  |
| D4   | username required                                                                          | the CLI rejects users without one                                                                 |
| D5   | email code only; phone, username and password off                                          | the CLI drops phones and usernames; Clerk stores passwords, which work once you turn passwords on |

### Targets

The Clerk instances are listed in `targets.json`. Each entry names the env
vars that hold its secret key and app ID.

| Target                            | Instance                                               | Used by                                                                                                                |
| --------------------------------- | ------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------- |
| `dev` (default)                   | the migrate-tests instance (`CLERK_MIGRATE_TESTS_1_*`) | every variation except the 10K ones and Clerk as a source; also the Clerk-as-source instance                           |
| `pool-1` (default for `-p clerk`) | the pool instance (`CLERK_POOL_1_*`)                   | Clerk as a source: the CLI won't import an export back into the instance it came from. Also `test:migrate-live:custom` |
| `10k-dev`                         | 10K dev (user limit raised to 10,000)                  | BK1K                                                                                                                   |
| `10k-prod`                        | 10K production                                         | BK                                                                                                                     |

`-t` also takes any name in `targets.json`, run as a development instance like
`dev`.

**`pool-1` isn't set up yet.** Until its instance exists and
`CLERK_POOL_1_SECRET_KEY` and `CLERK_POOL_1_APP_ID` are in 1Password (and in
`scripts/run-migrate-live-op.ts`), `-p clerk` and `test:migrate-live:custom`
stop with "CLERK_POOL_1_SECRET_KEY is not set". Everything else runs.

**CI uses its own `dev` and `pool-1` instances**, through the same env var
names, so a local run can't wipe a CI run's users there. The 10K instances
and the providers (Auth0 tenant, Turso DBs, Supabase project, Firebase
project, WorkOS) are shared. Don't run locally on Mondays 09:15–12:00 UTC,
when the weekly run is going, or while a manual run shows in the Actions tab.

`test:migrate-live` takes the provider's lock and the instance's lock before
it starts, and waits if another run holds either. The locks are directories
in `data/.locks/` on your machine, so they only see runs from this checkout.

## Every test

Every variation also checks how unverified emails and phones landed. Without
`--reserve-unverified` (the default, and what `-y`/`--json` keep), none may be
reserved. An `R` variation passes the flag, and every one must be reserved.

### Auth0 (`-p auth0`)

| ID  | What it tests                                                                  | Dests | Target |
| --- | ------------------------------------------------------------------------------ | ----- | ------ |
| A1  | email + password on the default DB connection (username and phone in metadata) | D1    | dev    |
| A2  | DB connection with `requires_username`: username on the real field             | D1    | dev    |
| A3  | Flexible Identifiers: `phone_number` as an identifier on the DB connection     | D1    | dev    |
| A4  | passwordless email only (`email\|` users)                                      | D1    | dev    |
| A5  | passwordless SMS only (`sms\|` users, phone-only)                              | D1    | dev    |
| A6  | combined: 8 DB + 5 passwordless email (2 share a DB email) + 3 SMS             | D1–D5 | dev    |
| A7  | edge cases: blocked, unverified email, heavy metadata, custom `user_id`        | D1    | dev    |

### Auth.js (`-p authjs`)

| ID  | What it tests                                                                                                                               | Dests | Target |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------- | ----- | ------ |
| J1  | magic link only: a timestamp verifies each user                                                                                             | D1    | dev    |
| J2  | GitHub only: unverified emails, and 1 in 4 users shared no email at all                                                                     | D1    | dev    |
| J2R | J2 with `--reserve-unverified`: the emails land reserved                                                                                    | D1    | dev    |
| J3  | email + GitHub: the exporter ignores account rows, so this exports like J1                                                                  | D1    | dev    |
| J4  | phone OTP: verified `<digits>@phone.local` placeholders, which Clerk refuses, so the dry run rejects those users                            | D1    | dev    |
| J5  | user table renamed to `users`: the exporter's fallback table name                                                                           | D1    | dev    |
| J6  | snake_case `email_verified` column (a Prisma `@map`, or legacy NextAuth): the exporter falls back to it, and half the users stay unverified | D1    | dev    |
| J7  | names of one, two and three words                                                                                                           | D1    | dev    |

### Better Auth (`-p better-auth`)

| ID   | What it tests                                                                                                             | Dests | Target   |
| ---- | ------------------------------------------------------------------------------------------------------------------------- | ----- | -------- |
| B0   | smoke: the app's own schema (username + phone plugins), 100 users                                                         | D1    | dev      |
| BP   | phone countries: every non-+1 phone in `users.json` (20 users, 8 countries)                                               | D1    | dev      |
| BI   | invalid phones on users with an email: Clerk creates them from the email and the CLI drops the phone                      | D1    | dev      |
| B1   | core only: email + password, no plugin columns                                                                            | D1    | dev      |
| B2   | + username plugin                                                                                                         | D1    | dev      |
| B3   | + phone plugin: verified, unverified and no phone                                                                         | D1    | dev      |
| B3R  | B3 with `--reserve-unverified`: the unverified phones land reserved                                                       | D1    | dev      |
| B4   | + admin plugin: 1 in 5 banned, and they stay banned in Clerk                                                              | D1    | dev      |
| B5   | + 2FA plugin: 1 in 3 email users enrolled (the CLI documents that MFA doesn't carry over)                                 | D1    | dev      |
| B6   | GitHub: social-only (no credential) and password + GitHub                                                                 | D1    | dev      |
| B7   | password formats: native scrypt, bcrypt, argon2id, and one no hasher accepts                                              | D1    | dev      |
| B8   | anonymous plugin: half the users are guests, which the CLI skips                                                          | D1    | dev      |
| B9   | every plugin at once, mixed cohorts; exact rejects checked per dest ([Expected failures](#expected-failures))             | D1–D5 | dev      |
| B10  | user table renamed to `users` (`modelName`): the exporter must refuse it with a clear message _(export expected to fail)_ | D1    | dev      |
| X1   | password required, half the users have none: imported, with a warning                                                     | D2    | dev      |
| X2   | `--require-password`: the CLI leaves out users without one                                                                | D1    | dev      |
| X3   | an email, a phone and a username already taken in Clerk: those 3 rejected, no others                                      | D1    | dev      |
| X4   | 1 user already in the dev instance, 100 to import: 1 rejected for the limit                                               | D1    | dev      |
| X5   | the same export imported twice: "already imported", nothing added                                                         | D1    | dev      |
| BK1K | 1K on the raised-limit dev instance: a 10% slice of `data/users-10k.json`                                                 | D1    | 10k-dev  |
| BK   | 10K on production: all of `data/users-10k.json`, to measure rate-limit throttling                                         | D1    | 10k-prod |

### Clerk as a source (`-p clerk`)

| ID  | What it tests                                                         | Dests | Target |
| --- | --------------------------------------------------------------------- | ----- | ------ |
| C1  | email + password                                                      | D1    | pool-1 |
| C2  | email + username + phone + password                                   | D1    | pool-1 |
| C3  | phone only, including a European number                               | D1    | pool-1 |
| C4  | email code only: no passwords at the source (D5 as the source config) | D1    | pool-1 |
| C5  | TOTP + backup codes on half the users, which the API can't export     | D1    | pool-1 |
| C6  | public, private and unsafe metadata, and banned users                 | D1    | pool-1 |

### Firebase (`-p firebase`)

| ID  | What it tests                                                                                                                                             | Dests | Target |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------- | ----- | ------ |
| F1  | email + password with Firebase's own scrypt: the hashes export and verify in Clerk                                                                        | D1    | dev    |
| F1H | F1, exported with a second service account (`FIREBASE_SERVICE_ACCOUNT_JSON_HASH_ROLE`), to test which IAM roles can export hashes ([Firebase](#firebase)) | D1    | dev    |
| F2  | email link only: no password                                                                                                                              | D1    | dev    |
| F3  | phone only                                                                                                                                                | D1    | dev    |
| F4  | email + password + phone                                                                                                                                  | D1    | dev    |
| F5  | imported bcrypt and HMAC_SHA256 hashes: Firebase exports them empty, so those passwords don't survive                                                     | D1    | dev    |
| F6  | Google: password + Google linked, and Google only (the exporter skips provider data)                                                                      | D1    | dev    |
| F7  | edge cases: disabled, unverified, custom claims and anonymous users                                                                                       | D1    | dev    |
| F8  | combined: every group, disabled users, Google links and bcrypt imports                                                                                    | D1–D5 | dev    |

### Supabase (`-p supabase`)

| ID  | What it tests                                                                                   | Dests | Target |
| --- | ----------------------------------------------------------------------------------------------- | ----- | ------ |
| S1  | email + password (GoTrue bcrypt)                                                                | D1    | dev    |
| S2  | passwordless (magic link or email OTP): `encrypted_password = ''`                               | D1    | dev    |
| S3  | phone only: Supabase stores numbers without the `+`, and the CLI adds it back                   | D1    | dev    |
| S4  | email + password + phone                                                                        | D1    | dev    |
| S5  | unconfirmed: half the emails and a third of the phones                                          | D1    | dev    |
| S6  | OAuth: GitHub only, Google only, and password + GitHub (Clerk dev has Google on and GitHub off) | D1    | dev    |
| S7  | edge cases: banned, soft-deleted, argon2id, heavy metadata, anonymous, SSO duplicate email      | D1    | dev    |
| S8  | combined: unconfirmed, banned, password + GitHub and passwordless users                         | D1–D5 | dev    |

### WorkOS (`-p workos`)

| ID  | What it tests                                                                                                    | Dests | Target |
| --- | ---------------------------------------------------------------------------------------------------------------- | ----- | ------ |
| W1  | email + password (WorkOS takes the bcrypt hash and never returns it)                                             | D1    | dev    |
| W2  | no password (Magic Auth style): exports the same shape as W1                                                     | D1    | dev    |
| W3  | unverified emails                                                                                                | D1    | dev    |
| W3R | W3 with `--reserve-unverified`: the emails land reserved                                                         | D1    | dev    |
| W4  | metadata: empty, at the limits (10 keys, 40-char keys, 600-char values), and the default                         | D1    | dev    |
| W5  | `external_id` at the 64-char limit, and name edge cases (unicode, first-only, last-only)                         | D1    | dev    |
| W6  | orgs, memberships, roles and TOTP factors: the export carries none, and the import must drop them without errors | D1    | dev    |
| W7  | combined: passwords, no password, unverified, metadata, `external_id`, orgs and TOTP                             | D1–D5 | dev    |
| W7R | W7 with `--reserve-unverified` on D2: an unverified-only email meets the email requirement                       | D2    | dev    |

---

## Custom sources

Six made-up auth providers (keyhole, passly, gatekeep, vaultrun, frostline,
nimbus), first written to test a skill that writes `clerk migrate` custom
sources. Here they test the CLI: the reference sources grade A+, so anything
less means the CLI regressed. The first four, each further from Clerk's shape
than the last:

| Provider | Distance from Clerk | What makes it hard                                                                                                              |
| -------- | ------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| Keyhole  | ~10–15%             | near-Clerk names (`phone_number`, `password_hash`), verified flags                                                              |
| Passly   | ~30%                | `{ users: [...] }` wrapper, display name only, nested credentials, `status`, Unix-second dates                                  |
| Gatekeep | ~50–60%             | `{ data: { accounts } }`, an `identities[]` array with the primary not first, pbkdf2 in parts, one mixed `attrs` blob, ms dates |
| Vaultrun | ~70%                | one `login` column holding an email, phone or username; a `vf` bitmask; `"Last, First"`; prefixed hashes; soft-deleted rows     |

Each provider has a JSON and a CSV export of the same 50 users. Every password
is a real hash of the seed password.

```
data/custom-sources/            the 12 exports: the only folder a skill should see
data/custom-sources-answers/    answer keys and reference sources: keep agents out
  <name>.expected.json          what each user should become in Clerk
  <name>.ts                     a hand-written source that grades A+ on both formats
```

`bun run test:migrate-live:custom` claims a Clerk target from the pool
([Targets](#targets)), sets it up for what the users hold
(phone, username, password; nothing required), dry-runs, imports, grades every
user against the answer key, then undoes the import.

**The grade.** Each expected fact counts as one check: the user exists, each
email and phone and its verification, primaries, username, names, banned,
password (it must sign in), and each metadata key. Accuracy is checks passed
over checks made, and a user that never landed fails all of its checks.

| Grade         | Accuracy                                                                       |
| ------------- | ------------------------------------------------------------------------------ |
| A+            | 100%                                                                           |
| A / B / C / D | ≥ 95% / 85% / 70% / 50%                                                        |
| F             | below 50%, or the run failed                                                   |
| —             | not run: setup failed (a Clerk timeout, no free target), so nothing was graded |

**The report** (`test-results/<stamp>-custom*/report.md`, or `--out`) groups
failures by field and reason: five users with a broken phone make one problem
listing five IDs. Gatekeep and Vaultrun don't say which metadata is public, so
there any metadata field passes and a different placement from the reference
source shows as a note.
