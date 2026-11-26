# `clerk agents`

Set up Clerk auth for agent tooling you build, such as MCP servers.

This group is for **your own** MCP server. `clerk mcp` is unrelated: it connects AI editors and CLIs to Clerk's hosted MCP server.

## Subcommands

### `clerk agents mcp configure <url>`

Registers an MCP server URL as an OAuth resource on an instance, so Clerk issues access tokens with that URL as the audience.

- The **first** MCP server on an instance also turns on `aud_claim_enabled` and `client_id_metadata_documents_advertised`, only the ones that are off. Later servers leave OAuth settings as they are and report the settings that still block MCP clients.
- A URL already registered as an MCP server changes nothing (URLs are compared the way the registry compares them: case-insensitive host, `:443` dropped).
- A URL held by a legacy Dashboard registration (no MCP marker, unowned, scopeless, named the way the Dashboard names one) is marked as an MCP server instead of created.
- A URL held by any other OAuth resource is refused (`oauth_resource_conflict`) before anything is written.
- Dynamic client registration, PKCE and consent settings are never changed.
- An application on the legacy OAuth provider is refused with `legacy_oauth_provider`.

The output carries the issuer, audience and protected resource metadata URL (RFC 9728 §3) the server should use, plus a setup prompt an agent can follow to implement it.

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

## API Endpoints

| Method | Endpoint                                                                           | Description                                  |
| ------ | ---------------------------------------------------------------------------------- | -------------------------------------------- |
| GET    | `/v1/platform/applications/{app_id}`                                               | Resolve the instance and its publishable key |
| GET    | `/v1/platform/applications/{app_id}/instances/{ins_id}/oauth_application_settings` | Read the instance's OAuth settings           |
| PATCH  | `/v1/platform/applications/{app_id}/instances/{ins_id}/oauth_application_settings` | Turn on the first-server settings            |
| GET    | `/v1/platform/applications/{app_id}/instances/{ins_id}/oauth_resources?limit=100`  | List registered OAuth resources              |
| POST   | `/v1/platform/applications/{app_id}/instances/{ins_id}/oauth_resources`            | Register the MCP server                      |
| PATCH  | `/v1/platform/applications/{app_id}/instances/{ins_id}/oauth_resources/{id}`       | Mark a legacy registration as an MCP server  |
