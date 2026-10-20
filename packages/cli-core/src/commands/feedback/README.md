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

| Option         | Required | What it is                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| -------------- | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--goal`       | yes      | What you were trying to do (up to 2,000 characters)                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `--attempted`  | yes      | What you ran and what you expected (4,000)                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `--issue`      | yes      | What went wrong or was confusing (4,000)                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `--outcome`    | yes      | `blocked`, `worked_around` or `succeeded_with_friction`                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `--command`    | no       | The CLI command involved, as typed after `clerk` (`users list`). A leading `clerk` is fine, and so is a whole pasted command line: arguments and flags after the command are dropped and never sent. Global flags before the command (`--mode agent users list`) are not read. The result is the spelling usage events record, so `deploy` lands as `deploy run` and `open users` as `open dashboard`; a bare group that runs nothing itself (`auth`) is an error naming its subcommands |
| `--error-text` | no       | The exact error you saw (4,000)                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `--error-code` | no       | The code from the error output, e.g. `not_linked`: lowercase letters, digits and underscores                                                                                                                                                                                                                                                                                                                                                                                             |
| `--suggestion` | no       | What would have helped (2,000)                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `--dry-run`    | no       | Print exactly what would be sent and send no report. The run's usual usage event for this command still applies, and the dry run may create the local machine id in the config file                                                                                                                                                                                                                                                                                                      |
| `--yes`        | no       | Skip the confirmation prompt (human mode)                                                                                                                                                                                                                                                                                                                                                                                                                                                |

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
  the workspace and app ids when a project is linked.

The report is built once per run. In human mode the object shown under "This is exactly
what will be sent" is the object that is posted.

Every text field is scrubbed before it is capped and before anything leaves your machine:
common secret formats (API keys and tokens by their prefixes, private key blocks,
`Authorization` headers, credentials in URLs, and assignments whose name contains a
secret-looking word such as SECRET, TOKEN, PASSWORD, API_KEY, PRIVATE_KEY or
ENCRYPTION_KEY (`CLERK_SECRET_KEY=...`)) become `[REDACTED]`; home-directory paths become
`~`; email addresses become `[EMAIL]`. Scrubbing is pattern-based and can miss things, so
never include secrets, API keys or personal data about end users. The scrubber is
documented in `src/lib/redact.ts`, including its known limits. Scrubbing runs on the
client, before truncation, so a secret cut in half by the cap cannot escape the pattern
that would have caught it whole.

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
then, no preview is shown, and no machine id is created.

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
`dev_build`, `rate_limited`, `send_failed`. `report_id` is present whenever a POST was
attempted, including `send_failed`: a send that timed out can still have reached the
endpoint, and the id is what a later removal needs.

Human mode prints the preview on stdout and the result on stderr: "Sent. Thank you.
Report id: <uuid>", or the reason, the issues URL and, if a POST was attempted, the id.
`--dry-run` prints the exact report (with the id it would carry) in both modes and sends no
feedback event.

A failed send (`send_failed`) is exit 0 in both modes: the JSON result is the delivery
signal, and a telemetry outage must never read as a task failure to a script or an agent.

## Opt-out, dev builds, rate limit

A telemetry opt-out (`CLERK_TELEMETRY_DISABLED`, `DO_NOT_TRACK`, or `clerk telemetry
disable`) blocks the send: `clerk telemetry disable` promises that nothing will be sent
from this machine, and an explicit report is still something sent. The command prints the
GitHub issues URL instead. A dev build without `CLERK_TELEMETRY_URL` sends nothing either.

At most 10 reports per machine in a rolling 24 hours, and no second report with the same
`command` and `error_code` inside that window (checked only when both are present). Over
either limit the result is `rate_limited`. The record is a best-effort JSON file in the CLI
cache directory; an unreadable file counts as empty, and only accepted sends are recorded.
Why this shape: agent-mode errors tend to come from retry loops, so a per-hour cap alone
would admit hundreds of identical reports a day from one busy machine. Known cost: two
distinct problems that share a command and code within a day are collapsed into one
report.

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
deadline, and reads and writes the local config file (machine id, notice flag) and the
rate-limit file in the cache directory.
