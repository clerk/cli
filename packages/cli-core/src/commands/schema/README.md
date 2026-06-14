# schema

Emits a stable JSON dump of the entire CLI command tree — every subcommand,
argument, and option — so agents and tooling can discover the surface
without parsing `--help` text.

## Usage

```sh
clerk schema           # JSON to stdout
clerk schema --json    # alias, kept for consistency with other commands
```

## Output

`{cli, version, schemaVersion, command}` where `command` is a recursive
`SchemaCommand` node with `name`, `aliases`, `description`, `arguments[]`,
`options[]`, and `subcommands[]`.

`schemaVersion` is bumped only on breaking shape changes.

## API endpoints

None. Pure CLI introspection.
