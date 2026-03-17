# `clerk schema`

Fetch and output the OpenAPI specification for Clerk APIs. Supports full-spec output, path-based introspection, type lookups, and `$ref` resolution.

## Usage

```
clerk schema                                     # List available APIs and versions
clerk schema backend                             # Backend API (latest, YAML)
clerk schema frontend                            # Frontend API (latest, YAML)
clerk schema platform                            # Platform API (latest, YAML)
clerk schema webhooks                            # Webhooks spec (latest, YAML)
clerk schema backend /users                      # Just the /users endpoint
clerk schema backend User                        # Just the User schema type
clerk schema backend /users --resolve-refs       # Endpoint with all $refs inlined
clerk schema backend User --resolve-refs         # Type with all $refs inlined
clerk schema backend --format json               # Full spec as JSON
clerk schema backend --spec-version 2024-10-01   # Specific version
clerk schema platform --output spec.yml          # Write to file
```

## Options

| Option                 | Description                                         |
| ---------------------- | --------------------------------------------------- |
| `[path]`               | Endpoint path (e.g. `/users`) or type (e.g. `User`) |
| `--spec-version <ver>` | Spec version (default: latest for the API)          |
| `--format <fmt>`       | Output format: `yaml` (default) or `json`           |
| `--output <file>`      | Write spec to a file instead of stdout              |
| `--resolve-refs`       | Inline `$ref` references for self-contained output  |

## Path introspection

When a second argument is provided, the command extracts just the matching portion of the spec:

- **Endpoint paths** start with `/` — e.g. `clerk schema backend /users` looks up the `/users` endpoint. Automatically tries `/v1` and `/v2` prefixes if an exact match isn't found.
- **Schema types** don't start with `/` — e.g. `clerk schema backend User` looks up the `User` schema in `components.schemas`. Case-insensitive matching is supported.

If no match is found, the command suggests similar paths or types.

## `--resolve-refs`

Inlines all `$ref` references so the output is fully self-contained. Circular references are detected and marked with a `$comment: "circular reference"` annotation instead of causing infinite expansion.

This is especially useful for AI agents that need a complete type definition without chasing references.

## APIs

| Name       | Aliases | Latest version | All versions                                               |
| ---------- | ------- | -------------- | ---------------------------------------------------------- |
| `backend`  | `bapi`  | `2025-11-10`   | 2021-02-05, 2024-10-01, 2025-03-12, 2025-04-10, 2025-11-10 |
| `frontend` | `fapi`  | `2025-11-10`   | 2021-02-05, 2024-10-01, 2025-03-12, 2025-04-10, 2025-11-10 |
| `platform` |         | `beta`         | beta                                                       |
| `webhooks` |         | `2025-04-15`   | 2025-04-15                                                 |

Specs are fetched from https://github.com/clerk/openapi-specs.

## Caching

Specs are cached locally for 24 hours to avoid repeated network requests. Cache is stored in the CLI's standard cache directory.

## No authentication required

This command fetches publicly available specs from GitHub and does not require authentication.
