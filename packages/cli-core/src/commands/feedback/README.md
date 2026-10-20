# clerk feedback

Send Clerk a structured report about a problem with the CLI: a command that exited 0 but
did something other than what you expected, an error that was confusing or wrong, or a
capability you needed and could not find.

## Usage

```sh
clerk feedback --goal <text> --attempted <text> --issue <text> --outcome <outcome> \
  [--command "<path>"] [--error-text <text>] [--error-code <code>] [--suggestion <text>] \
  [--dry-run] [--yes]
clerk feedback --input-json @report.json    # long text from a file; keys match the flags
```

| Option         | Required | What it is                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| -------------- | -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--goal`       | yes      | What you were trying to do (up to 2,000 characters)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `--attempted`  | yes      | What you ran and what you expected (4,000)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `--issue`      | yes      | What went wrong or was confusing (4,000)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `--outcome`    | yes      | `blocked`, `worked_around` or `succeeded_with_friction`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `--command`    | no       | The CLI command involved, as typed after `clerk` (`users list`). A leading `clerk` is fine, and so is a whole pasted command line: arguments and flags after the command are dropped and never sent. Global flags before the command (`--mode agent users list`) are not read. The result is the spelling usage events record, so `deploy` lands as `deploy run` and `open users` as `open dashboard`; a bare group that runs nothing itself (`auth`) is an error naming its subcommands. `help users` is accepted as typed, for any existing command, since `clerk help` records no usage event of its own                               |
| `--error-text` | no       | The exact error you saw (4,000)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `--error-code` | no       | The code from the error output, e.g. `not_linked`: lowercase letters, digits and underscores                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `--suggestion` | no       | What would have helped (2,000)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `--dry-run`    | no       | Print exactly what would be sent and whether a real run would send it now, and send no report. The run's usual usage event for this command still applies. With telemetry off, a dry run writes nothing, and the report shows the machine id the machine already has, or `null`. With telemetry on, it may create the config directory and the machine id, and while the first-run notice is still owed it writes and deletes a temporary file in the config directory to check that a real run could record the notice. On a first run the usual end-of-run step then shows the notice and records that it was shown, as for any command |
| `--yes`        | no       | Skip the confirmation prompt (human mode)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |

A text field longer than 1,000,000 characters is a usage error (exit 2, the JSON error
envelope in agent mode) naming the field and the limit, not a cut: the scrubber reads a
whole field before the cap is applied, and a cut before scrubbing could split a secret.
The limit is far above every cap, so it only ever meets a script that pasted a whole log
into one field.

Human mode prompts for any missing required field, shows the exact report, and asks before
sending. Agent mode never prompts.

## What is sent

One `CLI_FEEDBACK` event on the CLI's existing telemetry channel, next to the per-run usage
event. The run also sends its own usage event for this command (flag names only, as for
every command). The report carries:

- the fields above: `goal`, `attempted`, `issue`, `outcome`, `command` (null when not
  given), `error_text` (null), `error_code` (null), `suggestion` (null);
- `report_id`, a UUID generated on your machine and printed after sending; it is the only
  handle you hold for the report;
- `source: "cli"`, and `redactions`, the approximate number of replacements the scrubber
  made;
- the usual telemetry envelope: a random machine id, install method, detected AI agent,
  terminal, mode, OS, architecture, CI flag, tmux and screen flags, environment name, and
  the workspace and app ids when a project is linked;
- the wrapper every telemetry event carries: `sdk: "clerk-cli"` and `sdkv`, the CLI version.

The report is built once per run. In human mode the object shown under "This is exactly
what will be sent" is the whole event that is posted, wrapper included:
`{"sdk", "sdkv", "event": "CLI_FEEDBACK", "payload": {...}}`.

Every text field is scrubbed whole before it is capped and before anything leaves your
machine: common secret formats (API keys and tokens by their prefixes, including `sk-`
keys, private key blocks including PGP, `Authorization` headers, credentials in URLs,
assignments whose name contains a secret-looking word such as SECRET, TOKEN, PASSWORD,
API_KEY, PRIVATE_KEY or ENCRYPTION_KEY (`CLERK_SECRET_KEY=...`), the same names as
command-line flags (`--password x`), names with spaces (`api key: x`), YAML values on the
lines below a secret-looking key (`password: |` block scalars, and the children of a
parent such as `secrets:`), and escaped JSON pasted inside a string) become
`[REDACTED]`; home-directory paths become `~`; email addresses become `[EMAIL]`. The
variable or flag name stays and only the value goes (`export TOKEN=abc` becomes
`export TOKEN=[REDACTED]`), so a reader learns which setting was involved. An unquoted value is the rest of
its line when the name starts the line, after indentation and an optional `#`, `*`, `-`,
`+` or `1.` prefix (`DB_PASSWORD=a b c` loses all of `a b c`); in the middle of a line it
is one word, and inside a quoted string it runs to the string's closing quote, so the rest
of a one-line JSON object or log survives. An object or array under a secret-looking JSON
key goes whole (`{"secrets":{...}}`). Scrubbing is
pattern-based and can miss things, so never include secrets, API keys or personal data
about end users. The scrubber is documented in `src/lib/redact.ts`, including its known
limits (one to expect: a quoted value that spans several lines keeps its later lines).
Scrubbing runs on the client and sees the whole field, so a secret that runs past the
cap is still matched whole, and the cap is applied only afterwards.

**Never attached:** files, environment variables, transcripts, or the command line
(`argv`). The report is built only from the fields above and the envelope.

## Who can read it, and removal

Reports are stored in Clerk's internal telemetry warehouse next to usage events, readable
by Clerk staff with warehouse access. The CLI cannot delete one. To have a report removed,
contact Clerk support at https://clerk.com/contact/support with its report id. Acceptance
(`sent: true`) means the telemetry endpoint accepted the request; the write to the
warehouse happens afterwards and is not confirmed to the CLI.

## Order of operations

Both modes start by validating the shape of whatever was supplied (`--outcome` value,
`--command` path, `--error-code` pattern); an invalid value is a usage error (exit 2, the
JSON error envelope in agent mode) before anything else happens.

Agent mode: presence of every required field (a missing one is the usage error, never
`sent: false`), then `--dry-run`, then the telemetry opt-out check, then the rate limit,
then the first-run notice, then the POST. Presence comes before gating because missing
input is something the agent can fix, and nothing is typed, so nothing is wasted.

Human mode: `--dry-run` (prompting for missing fields first), then the opt-out check, then
the rate limit, then prompts for missing fields, then the opt-out check again, then the
preview and the confirmation, then the first-run notice, then the POST. Gating comes before
the prompts so someone opted out or capped is told before writing a report. The second
opt-out check catches an opt-out that landed while the editor was open: the person is told
then, no preview is shown, and no machine id is created. The opt-out is read once more
just before the first-run notice, so an opt-out that landed during the confirmation
neither posts nor uses up the notice.

The opt-out is also enforced inside the shared telemetry sender, at the moment of the POST,
so no telemetry event, including a feedback report, leaves an opted-out machine. The
per-run usage event uses the same sender.

## Output

Agent mode prints one JSON object on stdout and exits 0 in every case after validation:

```json
{"sent": true, "report_id": "<uuid>"}
{"sent": false, "reason": "<reason>", "fallback": "https://github.com/clerk/cli/issues"}
{"sent": false, "reason": "send_failed", "fallback": "...", "report_id": "<uuid>"}
```

`reason` is one of `telemetry_disabled` (an env var or `clerk telemetry disable`),
`dev_build`, `rate_limited`, `send_failed`. `report_id` is present exactly when a POST was
attempted, including a `send_failed` from a timeout, a rejection or a network failure: a
send that timed out can still have reached the endpoint, and the id is what a later
removal needs. A `send_failed` without a report id means the run failed before any POST
(the local config file could not be written or read, or the first-run notice could not be
recorded). Ctrl-C during the send is not a result: the command follows the CLI's
interrupt path and exits 130 without printing one.

Agent-mode `--dry-run` prints the event a real run would post, with whether it would post it now:

```json
{"dry_run": true, "would_send": true, "event": {...}}
{"dry_run": true, "would_send": false, "reason": "telemetry_disabled", "event": {...}}
```

`reason` takes the same values as `sent: false`.

Human mode prints the preview on stdout and the result on stderr: "Sent. Thank you.
Report id: <uuid>", or the reason, the issues URL and, if a POST was attempted, the id.
`--dry-run` prints the exact event (with the report id it would carry) on stdout and, on stderr,
whether a real run would send it now; it sends no feedback event.

A failed send (`send_failed`) is exit 0 in both modes: the JSON result is the delivery
signal, and a telemetry outage must never read as a task failure to a script or an agent.
A local config file that cannot be written or read is reported the same way, never as a crash.

## Opt-out, dev builds, rate limit

A telemetry opt-out (`CLERK_TELEMETRY_DISABLED`, `DO_NOT_TRACK`, or `clerk telemetry
disable`) blocks the send: `clerk telemetry disable` promises that nothing will be sent
from this machine, and an explicit report is still something sent. The command prints the
GitHub issues URL instead. A dev build without `CLERK_TELEMETRY_URL` sends nothing either.

At most 10 reports per machine in a rolling 24 hours, and no second report with the same
`command` and `error_code` inside that window (checked only when both are present). Over
either limit the result is `rate_limited`; the human-mode message says which of the two
applied. The record is a best-effort JSON file in the CLI cache directory; an unreadable
file counts as empty. A send is recorded whenever the request may have reached the
server: any response, accepted or not, and a timeout, because a send that timed out or was
rejected may still have landed and a retry loop against a slow endpoint must still meet
the cap. The CLI cannot tell a timeout before the connection from one after the request
was sent, so every timeout counts. A connection that was never made (refused, a host that
does not resolve, no network) sent nothing and is not recorded, and neither is a send
refused before any POST. The cap fails open: where the
cache file cannot be written, sends are accepted but not counted, because failing closed
would block feedback entirely in sandboxes that forbid cache writes. Why this shape: agent-mode
errors tend to come from retry loops, so a per-hour cap alone would admit hundreds of
identical reports a day from one busy machine. Known cost: two distinct problems that share
a command and code within a day are collapsed into one report.

## First run

On a machine that has never run the CLI, the disclosure notice shows and the report is
still sent, because the send is explicit. The notice's last line on this path says that
this run sends the feedback report and one usage event for this command. Every other first
run, including a first-run `--dry-run`, still sends nothing.

## Discovery

Discovery is through this help text rather than a hint on error output, because error
output doesn't reliably tell a failure from a status. `--error-code` lets the agent that
saw an error attach its code to the report without the CLI keeping any per-run record.

## Clerk API endpoints

None. The command POSTs one event to the telemetry endpoint
(`CLERK_TELEMETRY_URL`, default `https://clerk-telemetry.com/v1/event`) with a 5-second
deadline, reads and writes the local config file (machine id, notice flag), and reads and writes
the rate-limit file in the cache directory. A dry run sends nothing and never writes the
rate-limit file; what it may write is listed under `--dry-run` above.
