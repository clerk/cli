# `clerk openapi`

Fetch and output the OpenAPI specification for Clerk APIs.

## Usage

```
clerk openapi                                  # List available APIs and versions
clerk openapi backend                          # Backend API (latest, YAML)
clerk openapi frontend                         # Frontend API (latest, YAML)
clerk openapi platform                         # Platform API (latest, YAML)
clerk openapi webhooks                         # Webhooks spec (latest, YAML)
clerk openapi backend --format json            # Backend API as JSON
clerk openapi backend --spec-version 2024-10-01  # Specific version
clerk openapi platform --output spec.yml       # Write to file
```

## Options

| Option                 | Description                                |
| ---------------------- | ------------------------------------------ |
| `--spec-version <ver>` | Spec version (default: latest for the API) |
| `--format <fmt>`       | Output format: `yaml` (default) or `json`  |
| `--output <file>`      | Write spec to a file instead of stdout     |

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
