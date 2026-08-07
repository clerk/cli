# clerk telemetry

Control CLI usage telemetry.

## Usage

```sh
clerk telemetry status    # Show whether telemetry is enabled and why
clerk telemetry disable   # Persist an opt-out for this machine
clerk telemetry enable    # Remove the persisted opt-out
```

`status` prints the effective state and the winning reason, in precedence order: the
`CLERK_TELEMETRY_DISABLED` / `DO_NOT_TRACK` environment variables, then the persisted
opt-out from `clerk telemetry disable`, then the automatic dev-build guard. In agent
mode it emits the status object as JSON on stdout.

A run of `clerk telemetry disable` never sends a telemetry event itself — the opt-out
is re-checked after the command executes.

## Clerk API endpoints

None. These subcommands only read and write the local CLI config file
(`telemetryDisabled` flag). Telemetry events themselves are documented in the root
README's Telemetry section.
