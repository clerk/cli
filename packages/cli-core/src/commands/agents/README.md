# `clerk agents`

Set up Clerk auth for agent tooling you build, such as MCP servers.

This group is for **your own** MCP server. `clerk mcp` is unrelated: it connects AI editors and CLIs to Clerk's hosted MCP server.

## Subcommands

### `clerk agents mcp configure <url>`

Registers an MCP server URL as an OAuth resource on an instance, so Clerk issues access tokens with that URL as the audience.

- The **first** MCP server on an instance also turns on `aud_claim_enabled` and `client_id_metadata_documents_advertised`, only the ones that are off. Later servers leave OAuth settings as they are and report the settings that still block MCP clients. A legacy Dashboard registration counts as an existing server, unless it is the one this call marks.
- A URL already registered as an MCP server changes nothing (URLs are compared the way the registry compares them: case-insensitive host, `:443` dropped).
- A URL held by a legacy Dashboard registration (no MCP marker, unowned, scopeless, named the way the Dashboard names one) is marked as an MCP server instead of created.
- A URL held by any other OAuth resource is refused (`oauth_resource_conflict`) before anything is written.
- Dynamic client registration, PKCE and consent settings are never changed.
- An application on the legacy OAuth provider is refused with `legacy_oauth_provider`.

The output carries the issuer, audience and protected resource metadata URL (RFC 9728 §3, which keeps the resource's query) the server should use, plus a setup prompt an agent can follow to implement it.

This sequence mirrors the `configure_mcp_server` tool of Clerk's MCP connector (clerk/cloudflare-workers, `workers/remote-mcp-server/src/tools/mcp-server.ts`). Change both together. The connector's `replace_resource_url`, `dry_run` and hosted discovery check have no counterpart here.

#### Usage

```
clerk agents mcp configure <url> [options]
```

#### Options

| Option            | Description                                           |
| ----------------- | ----------------------------------------------------- |
| `--app <id>`      | Application ID to target (works from any directory)   |
| `--instance <id>` | Instance to target (dev, prod, or a full instance ID) |
| `--json`          | Output the result as JSON (the default in agent mode) |

#### Examples

```sh
clerk agents mcp configure https://mcp.example.com/mcp                      # Linked development instance
clerk agents mcp configure https://mcp.example.com/mcp --instance prod      # Production
clerk agents mcp configure https://mcp.example.com/mcp --app app_123 --json # Any application, as JSON
```

### `clerk agents mcp check [url]`

Reports each configuration check of an MCP server as pass or fail, and exits 1 with `mcp_check_failed` when any fails (the result is still printed first, as `clerk doctor` does).

| Check                         | Passes when                                                                                                                                                                                                                                                                                                                     |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `resource_registered`         | The URL is an OAuth resource marked as an MCP server. A legacy Dashboard registration fails and says to run `configure`.                                                                                                                                                                                                        |
| `aud_claim_enabled`           | Access tokens carry an audience claim.                                                                                                                                                                                                                                                                                          |
| `client_registration`         | MCP clients can register: client ID metadata documents or dynamic client registration is on (the `client_id_metadata_documents_advertised` blocker).                                                                                                                                                                            |
| `protected_resource_metadata` | An unauthenticated `GET` of the protected resource metadata URL (RFC 9728 §3) answers 200 with a JSON object whose `resource` is identical to the registered URL (RFC 9728 §3.3) and whose `authorization_servers` lists the issuer. Fails without a request when the issuer can't be read from the instance's publishable key. |

- The URL is optional when the instance has exactly one MCP server (or, with none, one legacy registration). With several, pass the URL. A URL that is neither is refused with `mcp_server_not_registered` before any request to it.
- Settings are read, never changed. No MCP request (no `POST`, no JSON-RPC) is sent to the server; the metadata `GET` is the only request to it.

The checks mirror the `check_mcp_server` tool of Clerk's MCP connector (same file as above). Change both together. The connector reads a hosted discovery checker; this command has none, so it reads the metadata itself.

#### Usage

```
clerk agents mcp check [url] [options]
```

Options are the same as `configure`'s.

#### Examples

```sh
clerk agents mcp check https://mcp.example.com/mcp # Linked development instance
clerk agents mcp check --instance prod --json      # Production's only MCP server, as JSON
```

## API Endpoints

| Method | Endpoint                                                                           | Description                                  |
| ------ | ---------------------------------------------------------------------------------- | -------------------------------------------- |
| GET    | `/v1/platform/applications/{app_id}`                                               | Resolve the instance and its publishable key |
| GET    | `/v1/platform/applications/{app_id}/instances/{ins_id}/oauth_application_settings` | Read the instance's OAuth settings           |
| PATCH  | `/v1/platform/applications/{app_id}/instances/{ins_id}/oauth_application_settings` | Turn on the first-server settings            |
| GET    | `/v1/platform/applications/{app_id}/instances/{ins_id}/oauth_resources?limit=100`  | List registered OAuth resources              |
| POST   | `/v1/platform/applications/{app_id}/instances/{ins_id}/oauth_resources`            | Register the MCP server                      |
| PATCH  | `/v1/platform/applications/{app_id}/instances/{ins_id}/oauth_resources/{id}`       | Mark a legacy registration as an MCP server  |

`check` only sends the `GET` requests above, plus an unauthenticated `GET` of the MCP server's protected resource metadata URL.
