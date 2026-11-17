---
"clerk": minor
---

Make `clerk logs` available without `CLERK_EXPERIMENTAL=logs`: it now shows in `clerk --help` and shell completion.

- `clerk logs list` (or just `clerk logs`) lists an instance's Application Logs, newest first, filtered by event type, user, session, IP, payload field and more, over a time range from `--since`, `--from` and `--to`.
- `--grouped` shows each sign-in and sign-up flow as one row with its events, `clerk logs get <sia_|sua_ id>` shows one flow's logs, and `--follow` keeps printing new logs as they arrive.
- `clerk logs schema` lists the event types and the payload fields you can filter on.
- `--json`, implied in agent mode, prints the Backend API's objects with a cursor for the next page (one log per line with `--follow`), and errors print as JSON with a code.
