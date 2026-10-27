# clerk feedback

Send Clerk a structured report about a problem with the CLI: a command that exited 0 but
did something other than what you expected, an error that was confusing or wrong, or a
capability you needed and could not find. A report can also describe an improvement that
would have helped.

## Usage

```sh
clerk feedback --goal <text> --attempted <text> --issue <text> --outcome <outcome> \
  [--command "<path>"] [--error-text <text>] [--error-code <code>] [--suggestion <text>] \
  [--dry-run] [--yes]
clerk feedback --input-json @report.json    # long text from a file; keys match the flags
```

| Option         | Required | What it is                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| -------------- | -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--goal`       | yes      | What you were trying to do (up to 2,000 characters)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `--attempted`  | yes      | What you ran and what you expected (4,000)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `--issue`      | yes      | What went wrong or was confusing (4,000)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `--outcome`    | yes      | `blocked`, `worked_around` or `succeeded_with_friction`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `--command`    | no       | The CLI command involved, as typed after `clerk` (`users list`). A leading `clerk` is fine (also `npx -y clerk@latest`, `bunx clerk@latest` or `pnpm dlx clerk@latest`), and so is a whole pasted command line: global flags are skipped wherever they come, and so are a group's own (`--mode agent users list`, `users --mode agent list` and `users --app app_123 list` are all `users list`; `--version`, which runs no command, is an error), and arguments and flags after the command are dropped and never sent. The result is the spelling usage events record, so `deploy` lands as `deploy run` and `open users` as `open dashboard`; a bare group that runs nothing itself (`auth`) is an error naming its subcommands. `help users` is accepted as typed, for any existing command, since `clerk help` records no usage event of its own                                                                       |
| `--error-text` | no       | The exact error you saw (4,000)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `--error-code` | no       | The code from the error output, e.g. `not_linked`: letters, digits and underscores. It is sent in lowercase, so `NOT_LINKED` and `not_linked` are the same code for the rate limit                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `--suggestion` | no       | What would have helped (2,000)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `--dry-run`    | no       | Print exactly what would be sent and whether a real run would send it now, judged by the telemetry opt-out and the rate limit, and send no report. A real run can still fail to write the local config file, and then reports `send_failed`. The report id is the placeholder `<assigned when sent>`, since only a real send assigns one. The run's usual usage event for this command still applies. With telemetry off, a dry run writes no machine id, notice flag or rate-limit record, and the report shows the machine id the machine already has, or `null`. In agent mode, the sandbox check every command that reads the config runs may still create the config directory and write and delete a temporary file there. With telemetry on, it may create the config directory and the machine id. On a first run the usual end-of-run step then shows the notice and records that it was shown, as for any command |
| `--yes`        | no       | Skip the confirmation prompt (human mode)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |

A text field longer than 1,000,000 characters is a usage error (exit 2, the JSON error
envelope in agent mode) naming the field and the limit, not a cut: the scrubber reads a
whole field before the cap is applied, and a cut before scrubbing could split a secret.
The limit is far above every cap, so it only ever meets a script that pasted a whole log
into one field.

Human mode prompts for any missing required field, shows the exact report, and asks before
sending. An editor left empty cancels the report instead of reopening. Agent mode never
prompts.

## What is sent

One `CLI_FEEDBACK` event on the CLI's existing telemetry channel, next to the per-run usage
event. The run also sends its own usage event for this command (flag names only, as for
every command). The report carries:

- the fields above: `goal`, `attempted`, `issue`, `outcome`, `command` (null when not
  given), `error_text` (null), `error_code` (null), `suggestion` (null);
- `report_id`, a UUID generated on your machine and printed after sending; it is the only
  handle you hold for the report (a dry run shows `<assigned when sent>` instead);
- `source: "cli"`, and `redactions`, the approximate number of replacements the scrubber
  made;
- the usual telemetry envelope: a random machine id, install method, detected AI agent,
  terminal, mode, OS, architecture, CI flag, tmux and screen flags, environment name, and
  the workspace and app ids when a project is linked;
- the wrapper every telemetry event carries: `sdk: "clerk-cli"` and `sdkv`, the CLI version.

The report is built once per run. In human mode the object shown under "This is exactly
what will be sent" is the whole event that is posted, wrapper included:
`{"sdk", "sdkv", "event": "CLI_FEEDBACK", "payload": {...}}`.

Every text field is scrubbed on the client, whole, before it is capped and before anything
leaves your machine. **Scrubbing is best-effort.** It catches secrets by their shape:

- API keys and tokens by their prefixes (Clerk `sk_`/`pk_`/`rk_` and `ak_` keys, Clerk M2M
  `mt_` and OAuth `oat_` tokens, Clerk dev-browser `dvb_` tokens, GitHub,
  Slack, npm, AWS, Google, Stripe webhook secrets, JWTs, and `sk-` keys such as OpenAI's and
  Anthropic's);
- private key blocks, PGP included;
- `Authorization`, `Cookie` and `Set-Cookie` headers, and `Bearer` or `Basic` tokens in prose;
- a value assigned on one line to a secret-looking name: a name containing SECRET, TOKEN,
  PASSWORD, PASSWD, CREDENTIAL, API_KEY, PRIVATE_KEY, ENCRYPTION_KEY, ACCESS_KEY,
  SIGNING_KEY, SESSION_KEY, AUTHORIZATION, or AUTH, PASS or PWD
  as a whole segment (`CLERK_SECRET_KEY=...`, `export DATABASE_PASSWORD=...`,
  `"apiToken": "..."`, `X_AUTH=...`, `DB_PASS=...`, camelCase `dbPass=...` and `--dbPass ...`; the shell's
  `PWD=/path` is left alone),
  a spaced name such as `api key:` or `client secret:`, and the same names as command-line
  flags (`--password x`, `--token=x`, `--api_key x`). The separator may be `:`, `=`, `:=`,
  `=>`, `==` or `===`;
- credentials in URLs (`postgres://user:password@host`);
- curl's `-u user:password` and `--user user:password`, the whole value, on a line that
  runs curl (`docker run -u 1000:1000` keeps its ids, and `-u user` with no colon, where
  curl asks for the password, is left alone).

Secrets become `[REDACTED]`, home-directory paths become `~`, and email addresses become
`[EMAIL]`. The variable or flag name stays and only the value goes (`export TOKEN=abc`
becomes `export TOKEN=[REDACTED]`), so a reader learns which setting was involved. Where
a value ends:

- after a bare name (`NAME=value`, `name: value`): an unquoted value at the first space or
  double quote, a quoted one at its closing quote; a `Bearer` or `Basic` value takes the
  token after it too (`token: Bearer xyz` loses `Bearer xyz`);
- after a JSON field name (`"name": value`): a quoted value at its closing quote, an
  unquoted one at the first space, `,`, `;` or `}`;
- after a flag: one shell word, through any quoted part it contains
  (`--token MY_TOKEN="alpha beta"` loses all of `MY_TOKEN="alpha beta"`);
- an `Authorization` header: the rest of the line, or the closing quote when the header
  sits inside a quoted string (`curl -H "Authorization: …" https://…` keeps the URL).

Home directories are recognised as `/Users/<name>`, `/home/<name>` and `C:\Users\<name>`,
including `C:/Users/<name>`, Git Bash's `/c/Users/<name>` and WSL's `/mnt/c/Users/<name>`;
punctuation after the user name stays (`(/Users/bob)` becomes `(~)`).

It does not understand structure, so it misses: values that span several lines; values in
structured config files such as YAML blocks and pretty-printed or nested JSON; passwords
with spaces in them (`password: correct horse` keeps `horse`); a password attached to a
short flag (`mysql -pS3cret`); and Markdown formatting around a label (`**Password**: x`).
It also replaces some values that are not secrets, the safe direction: any name containing
TOKEN or CREDENTIAL loses its value (`max_tokens=4096`, fetch's `credentials: "include"`,
git's `credential.helper=store`). **Never include secrets, API keys or personal data
about end users.** The scrubber and its known limits are documented in `src/lib/redact.ts`.
Because it sees the whole field, a secret that runs past the cap is still matched whole,
and the cap is applied only afterwards.

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
`dev_build`, `rate_limited`, `send_failed`. `report_id` is present exactly when the
report may have been stored, including a `send_failed` from a timeout, a 5xx answer or a
failure the CLI cannot place: a send that timed out can still have landed, and the id is
what a later removal needs. A `send_failed` without a report id means nothing was stored:
the run failed before any POST (the local config file could not be written or read, or the
first-run notice could not be recorded), the connection was never made (refused, a host
that does not resolve, no network, a sandbox blocking it, a server certificate the CLI
rejected), or the endpoint refused the
report with a 4xx answer. The CLI decides that a connection was never made only from the
structured error code, never from the error message or the URL. Ctrl-C during the send is not a result: the command follows the CLI's
interrupt path and exits 130 without printing one. A send interrupted after the request
went out is usually counted against the rate limit first, but the CLI's interrupt handler
can exit before that record is written.

Agent-mode `--dry-run` prints the event a real run would post, with whether it would post it now:

```json
{"dry_run": true, "would_send": true, "event": {...}}
{"dry_run": true, "would_send": false, "reason": "telemetry_disabled", "event": {...}}
```

`reason` takes the same values as `sent: false`.

Human mode prints the preview on stdout and the result on stderr: "Sent. Thank you.
Report id: <uuid>", or the reason, the issues URL and, if the report may have been stored,
the id. `--dry-run` prints the exact event (with `<assigned when sent>` as its report id) on
stdout and, on stderr,
whether a real run would send it now; it sends no feedback event.

A failed send (`send_failed`) is exit 0 in both modes: the JSON result is the delivery
signal, and a telemetry outage must never read as a task failure to a script or an agent.
A local config file that cannot be written or read is reported the same way, never as a crash.

## Opt-out, dev builds, rate limit

A telemetry opt-out (`CLERK_TELEMETRY_DISABLED`, `DO_NOT_TRACK`, or `clerk telemetry
disable`) blocks the send: `clerk telemetry disable` promises that nothing will be sent
from this machine, and an explicit report is still something sent. The command prints the
GitHub issues URL instead. A dev build without `CLERK_TELEMETRY_URL` sends nothing either.

At most 50 reports per machine in a rolling 24 hours, and no second report with the same
`command` and `error_code` inside that window (checked only when both are present). Over
either limit the result is `rate_limited`; the human-mode message says which of the two
applied. The record is a best-effort JSON file in the CLI cache directory; an unreadable
file counts as empty. A send is recorded whenever the request may have reached the
server: any response, accepted or not, and a timeout, because a send that timed out or was
answered with a 5xx may still have landed and a retry loop against a slow endpoint must
still meet the cap. A 4xx answer means the endpoint refused the report and stored nothing,
so it counts toward the 50 but never toward the repeat check: a corrected retry about the
same command and code goes through, and a retry loop against an endpoint that refuses
every report still stops at 50. The CLI cannot tell a timeout before the connection from one after the request
was sent, so every timeout counts. A connection that was never made (refused, a host that
does not resolve, no network, a sandbox blocking it, a server certificate the CLI rejected)
sent nothing and is not recorded, and
neither is a send refused before any POST. The cap fails open: where the
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
