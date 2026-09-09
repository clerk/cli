# Security Commands

Grade a Clerk instance against Clerk's security recommendations, and apply
the config changes that close the gaps.

The audit is a pure function over the instance's Platform API config
document: one `GET`, a fixed catalog of checks, and a `clerk config patch`
payload per fixable check. Nothing is stored server-side; every run
re-evaluates from the live configuration.

## Usage

```sh
clerk security                       # Audit the linked development instance
clerk security audit --instance prod # Audit production
clerk security audit --json          # Machine-readable report
clerk security audit --spotlight     # Only unmet and blocked recommendations
clerk security fix                   # Pick which recommendations to apply
clerk security fix user-lockout      # Apply one recommendation by id
clerk security fix mfa --factors authenticator,backup-code   # A recommendation that needs a choice
clerk security fix --all --dry-run   # Preview every fixable change
clerk security checks                # List the catalog (no network)
```

### `clerk security audit`

Fetches the config document, evaluates every applicable check, prints the
report, and sets the exit code from `--fail-on`. `clerk security` with no
subcommand runs `audit`.

Each row shows the recommendation's title, its id, and the current versus
recommended value, so the id `fix` takes is right there:

```
Critical
✗ Two-factor authentication   mfa            Not available → Available  (manual)
✓ Bot sign-up protection      bot-protection
Recommended
! Require two-factor auth     mfa-required   blocked: make "Two-factor authentication" available first (`mfa`)
✗ Passkeys                    passkeys       Disabled → Enabled
```

| Flag                | Description                                                                                                    |
| ------------------- | -------------------------------------------------------------------------------------------------------------- |
| `--app <id>`        | Application ID to target (works from any directory)                                                            |
| `--instance <id>`   | Instance to target (`dev`, `prod`, or a full instance ID). Defaults to development.                            |
| `--json`            | Output the report as JSON (automatic in agent mode)                                                            |
| `--spotlight`       | Only show unmet and blocked recommendations                                                                    |
| `--fail-on <level>` | Lowest severity of an unmet recommendation that exits 1: `critical` (default), `recommended`, `any`, or `none` |

### `clerk security fix [ids...]`

Re-runs the audit, builds one config patch from the selected recommendations,
and applies it through the same path as `clerk config patch`: printed diff,
confirmation prompt, server-side `--dry-run`, and result reporting. With no
ids and no `--all`, human mode opens a checklist of the fixable gaps;
deselecting everything cancels without writing.

| Flag                | Description                                                                                                                                                                   |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `[ids...]`          | Recommendation ids to fix, as shown in the audit. Omit them in human mode to pick from a checklist of the fixable gaps (all preselected). Agent mode requires ids or `--all`. |
| `--check <id>`      | Same as a positional id; repeatable, so `--input-json` can pass `{"check":[...]}`                                                                                             |
| `--all`             | Fix every unmet critical and recommended check that has an inline patch. Add `--factors` or `--strategy` to include the decision checks too.                                  |
| `--good-to-have`    | With `--all`, also apply the good-to-have tier.                                                                                                                               |
| `--factors <list>`  | Second factors for `mfa`: `authenticator`, `backup-code`, `sms` (comma-separated or repeated). Asked interactively when omitted in human mode; required in agent mode.        |
| `--strategy <name>` | Sign-in method for `passwordless-auth`: `email-code`, `email-link`, `phone-code`, `passkey`. Asked interactively when omitted in human mode; required in agent mode.          |
| `--app <id>`        | Application ID to target                                                                                                                                                      |
| `--instance <id>`   | Instance to target                                                                                                                                                            |
| `--dry-run`         | Validate server-side and preview the diff without applying it                                                                                                                 |
| `--yes`             | Skip the confirmation prompt. Required in agent mode unless `--dry-run` is passed.                                                                                            |
| `--json`            | Print the result summary as JSON (automatic in agent mode)                                                                                                                    |

Ids that are already met or not applicable are skipped with a note. Two
recommendations are product decisions rather than pure config changes: `mfa`
(which second factors) and `passwordless-auth` (which sign-in method). `fix`
asks in human mode and takes `--factors` / `--strategy` in agent mode, then
patches like any other check. `oauth-custom-credentials` needs credentials
from the provider and stays manual. A blocked id (`mfa-required`) is accepted
when its prerequisite is in the same call, e.g.
`clerk security fix mfa mfa-required --factors authenticator`, and `--all`
pulls it in automatically once `--factors` is given. Anything else that cannot
be applied exits 2 with a usage error naming the remedy, before anything is
written. Unknown ids exit 2 with the list of valid ids. Passing both ids and
`--all` is an error.

Backup codes require another second factor: choose `authenticator` or `sms` alongside `backup-code`. Mandatory MFA enables enrollment for both sign-ups and sign-ins. Fixing breached-password sign-in protection also enables breach detection.

Patches are applied sequentially onto a projected copy of the document, so a
later check sees the earlier ones' changes. This is what lets `--all` set the
two lockout checks without one clobbering the other, and lets checks
that emit whole arrays (`verification_strategies`) compose.

After the write, `fix` re-evaluates every check against the document the
server returned (the projection, under `--dry-run`) and prints the grade
change, e.g. `Grade F → C · 16 of 20 recommendations met`. With `--json` or in
agent mode it prints a summary:

```json
{
  "changed": true,
  "dryRun": false,
  "applied": ["user-lockout", "device-trust"],
  "decisions": {},
  "skipped": [{ "id": "bot-protection", "reason": "met" }],
  "score": { "before": { "grade": "F", "…": "…" }, "after": { "grade": "C", "…": "…" } },
  "remaining": ["mfa", "mfa-required", "passwordless-auth"]
}
```

`changed` is false when nothing was sent: every id was skipped, or the patch
matched the current document. `reason` is `met` or `not_applicable`.
`remaining` lists the ids still unmet or blocked afterwards. `decisions`
records the values each decision check was applied with, e.g.
`{ "mfa": ["authenticator", "backup-code"] }`.

### `clerk security checks`

Prints the catalog: id, title, severity, description, the config path each
check reads, whether it has an inline fix, and a docs link. Makes no network
requests and needs no credentials.

## Requirements

- A linked project, or `--app <id>`.
- Authenticated via `CLERK_PLATFORM_API_KEY` or `clerk auth login`.
- Account mode only. An unclaimed accountless application exits with
  `auth_required`: the checks read the account-level config document, and
  Clerk's Backend API only exposes bot protection and organization settings to
  an instance secret key.

## Checks

Severity is anchored to threat impact. `critical` is the credential-stuffing
and account-takeover kill chain; one unmet critical control caps the grade at
C regardless of the percentage. Password composition rules
(`require_uppercase` and friends) and zxcvbn strength scores are deliberately
not checked; Clerk no longer recommends them, following NIST 800-63B. Length
and breach detection are what count.

| Id                         | Severity     | Met when                                                                                                       | Fix                               |
| -------------------------- | ------------ | -------------------------------------------------------------------------------------------------------------- | --------------------------------- |
| `bot-protection`           | critical     | `auth_attack_protection.bot_protection.captcha_enabled`                                                        | patch                             |
| `breach-detection`         | critical     | `auth_password.disable_hibp` is false                                                                          | patch                             |
| `user-lockout`             | critical     | `auth_attack_protection.user_lockout.enabled`                                                                  | patch                             |
| `device-trust`             | critical     | `auth_password.device_trust.enabled`                                                                           | patch                             |
| `mfa`                      | critical     | authenticator app, backup codes, or SMS second factor enabled                                                  | asks `--factors`                  |
| `passwordless-auth`        | critical     | email/SMS code, passkey, web3, or a social connection is a first factor                                        | asks `--strategy`                 |
| `email-verification`       | critical     | `auth_email.verify_at_sign_up` (only when email is a sign-up identifier)                                       | patch                             |
| `breach-detection-sign-in` | recommended  | `auth_password.enforce_hibp_on_sign_in` and `disable_hibp`                                                     | patch                             |
| `lockout-threshold`        | recommended  | lockout enabled and `max_attempts <= 10`                                                                       | patch                             |
| `mfa-required`             | recommended  | `auth_multi_factor.required_for_sign_up`                                                                       | patch, blocked until `mfa` is met |
| `passkeys`                 | recommended  | `auth_passkey.used_for_sign_in`                                                                                | patch                             |
| `phone-verification`       | recommended  | `auth_phone.verify_at_sign_up` (only when phone is a sign-up identifier)                                       | patch                             |
| `password-min-length`      | recommended  | `auth_password.min_length >= 8` (only when passwords are enabled)                                              | patch                             |
| `allowlist-on-sign-in`     | recommended  | `auth_access_control.allowlist_blocklist_enforced_on_sign_in` (only when an allowlist or blocklist is enabled) | patch                             |
| `oauth-custom-credentials` | recommended  | every enabled `connection_oauth_*` has a `client_id` (production only)                                         | manual                            |
| `email-link-same-client`   | good-to-have | `auth_attack_protection.email_link_require_same_client` (email only)                                           | patch                             |
| `session-lifetime`         | good-to-have | `session_settings.maximum_lifetime.enabled`                                                                    | patch                             |
| `block-disposable-email`   | good-to-have | `auth_access_control.block_disposable_email_domains` (email only)                                              | patch                             |
| `block-email-subaddresses` | good-to-have | `auth_access_control.block_email_subaddresses` (email only)                                                    | patch                             |

Every check except `password-min-length`, `allowlist-on-sign-in`, and
`oauth-custom-credentials` mirrors the Dashboard's security recommendations;
those three are CLI-only.

Three states per finding:

The **good-to-have** tier is hardening that costs users some convenience:
magic links that must open on the requesting device, and the two email
blocks. It counts toward the score like anything else, but `fix --all` and
the interactive picker leave it out unless asked (`--good-to-have`, or
ticking the rows), so a blanket `fix --all` never changes what end users
experience beyond a CAPTCHA and verification.

- **met**: nothing to do.
- **unmet**: a real gap. Has a `patch` when the fix is a pure config change.
- **blocked**: a real gap that cannot be applied until a prerequisite is met
  (`mfa-required` needs `mfa`). Still counts against the score.

Checks that have no meaning for the instance are **not applicable** and are
left out of the report and the score entirely: the email checks when email is
not a sign-up identifier, the phone check when phone is not, the four
password checks (`breach-detection`, `breach-detection-sign-in`,
`device-trust`, `password-min-length`) when
`auth_password.enabled` is false, and the OAuth check outside production.

Three controls depend on a Clerk billing feature and carry a `feature` key in
the report: `mfa` (`app:mfa_totp`), `passkeys` (`app:passkey`), and
`session-lifetime` (`app:custom_session_duration`). The config document does
not say which plan the application is on, so a production instance whose plan
lacks the feature learns that from the API's error when `fix` writes. They
still count against the score; run `fix --dry-run` first when that matters.

## Score

Weighted by severity (critical 3, recommended 2, good-to-have 1). A is 95 %
or more, B 80 %, C 60 %, D 40 %, F below. Any unmet or blocked critical
recommendation caps the grade at C.

## Agent / CI Usage

Agents get JSON automatically; `--json` forces it for humans too.

```sh
clerk security checks --json                     # Discover ids and what they mean
clerk security audit --json --spotlight          # Only the gaps
clerk security fix <ids...> --yes                # Apply, no prompt
clerk security fix --all --dry-run               # Server-validated preview
```

The report:

```json
{
  "instance": {
    "appId": "app_…",
    "instanceId": "ins_…",
    "environmentType": "development",
    "label": "My App (development)"
  },
  "score": { "grade": "C", "percent": 71, "met": 14, "total": 20, "hasCriticalGap": true },
  "fixCommand": "clerk security fix user-lockout device-trust --app app_… --instance ins_… --yes",
  "findings": [
    {
      "id": "user-lockout",
      "title": "Brute-force lockout",
      "severity": "critical",
      "status": "unmet",
      "description": "Lock accounts after repeated failed sign-in attempts.",
      "path": "auth_attack_protection.user_lockout.enabled",
      "currentValue": false,
      "recommendedValue": true,
      "current": "Disabled",
      "recommended": "Enabled",
      "patch": { "auth_attack_protection": { "user_lockout": { "enabled": true } } },
      "suggestedPatch": null,
      "remedy": "Run `clerk security fix user-lockout --app app_… --instance ins_…`.",
      "docsUrl": "https://clerk.com/docs/guides/secure/user-lockout.md",
      "dashboardUrl": "https://dashboard.clerk.com/apps/app_…/instances/ins_…/user-authentication"
    },
    {
      "id": "mfa",
      "severity": "critical",
      "status": "unmet",
      "feature": "app:mfa_totp",
      "patch": null,
      "suggestedPatch": {
        "auth_multi_factor": {
          "authenticator_app": { "enabled": true },
          "backup_code": { "enabled": true }
        }
      },
      "decision": {
        "flag": "factors",
        "multiple": true,
        "options": ["authenticator", "backup-code", "sms"],
        "suggested": ["authenticator", "backup-code"]
      },
      "remedy": "Run `clerk security fix mfa --factors authenticator,backup-code --app app_… --instance ins_… --yes` (or pick other authenticator, backup-code, sms).",
      "…": "…"
    }
  ]
}
```

- `patch` is the literal payload `clerk config patch --json` accepts, so an
  agent can apply it through any path. It is `null` for met, blocked, and
  manual findings.
- `decision` is set on the two findings that need a choice: `{ flag, multiple,
options, suggested }`. Pass the values with `--<flag>` to `fix`; `remedy`
  already spells out the command with the suggested values, e.g.
  `clerk security fix mfa --factors authenticator,backup-code --app … --instance …`.
  `suggestedPatch` is the config patch those suggested values produce, for
  agents that prefer `clerk config patch`. Confirm the choice with the user
  when it matters (SMS costs money, passkeys need client support).
- `feature` names the billing feature a control depends on (see Checks).
- `fixCommand` lists the fixable critical and recommended gaps; good-to-have
  ids are applied only when named explicitly or via `--all --good-to-have`.
  It and every `remedy` pin `--app` and `--instance` to the audited instance,
  so a copied command cannot drift to another one. In agent mode they also
  carry `--yes`, which `fix` requires there.
- `docsUrl` points at the raw markdown (`.md`) in agent mode, like `CliError`.
- `fix` prints `{ changed, dryRun, applied, skipped, score: { before, after }, remaining }`
  on stdout in agent mode or with `--json`; see the fix section above.
- Errors are JSON on stderr with a `code`; stdout stays a single JSON document.

Findings are ordered critical, recommended, good-to-have, and within a severity
unmet, blocked, met.

Check ids are validated by the command rather than by Commander's `.choices()`
so an unknown id produces a structured usage error listing the valid ids;
tab completion for the ids is registered separately in `completion/__complete.ts`.

## Exit Codes

| Code | Meaning                                                                                                        |
| ---- | -------------------------------------------------------------------------------------------------------------- |
| 0    | No unmet recommendation at or above `--fail-on`; `fix` applied or had nothing to do                            |
| 1    | `audit`: unmet recommendations at or above `--fail-on` (error code `security_audit_failed`); or an API failure |
| 2    | Usage error: missing or unknown ids, manual/blocked ids, agent mode without `--yes`                            |

## API Endpoints

All requests go to the Clerk Platform API (default `https://api.clerk.com`,
overridable via `CLERK_PLATFORM_API_URL`), authenticated via `Bearer` token
from `CLERK_PLATFORM_API_KEY` or the stored `clerk auth login` session.

| Method  | Endpoint                                                          | Description                                                                                         |
| ------- | ----------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| `GET`   | `/v1/platform/applications/{appID}/instances/{instanceID}/config` | Fetches the config document every check reads. One call per `audit` or `fix` run.                   |
| `GET`   | `/v1/platform/applications/{appID}?include_secret_keys=true`      | Only when `--app` is passed or `--instance` is a literal id, to resolve the instance's environment. |
| `PATCH` | `/v1/platform/applications/{appID}/instances/{instanceID}/config` | `fix` only. Sends `?dry_run=true` under `--dry-run`.                                                |

`clerk security checks` makes no requests.
