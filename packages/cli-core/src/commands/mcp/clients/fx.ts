/**
 * Writes fx's user-global `~/.fx/mcp.json` directly — the only config surface
 * fx loads MCP servers from (repo-local MCP files are deliberately never
 * loaded). fx does ship `fx mcp add --transport http` (verified in 0.0.7),
 * but it is newer than fx's own docs, so the direct write keeps registration
 * working on fx binaries that predate it. fx speaks Streamable HTTP
 * natively, so unlike the bridge-backed clients the entry points straight at
 * the remote URL: entries live under top-level `mcp` as
 * `{ "type": "http", "url": … }`. The URL is therefore embedded at install
 * time rather than resolved by `clerk mcp run` at connect time.
 */

import { isRecord } from "../../../lib/objects.ts";
import { makeJsonClient } from "./make-client.ts";
import { pathExists, userPath } from "./paths.ts";

function extractFxUrl(descriptor: unknown): string | undefined {
  if (!isRecord(descriptor)) return undefined;
  const url = (descriptor as { url?: unknown }).url;
  return typeof url === "string" ? url : undefined;
}

export const fxClient = makeJsonClient({
  id: "fx",
  displayName: "fx",
  scope: "user",
  activation: "Run `/mcp reload` inside an fx session (or restart fx); `/mcp list` verifies.",
  topKey: "mcp",
  encode: (url) => ({ type: "http", url }),
  extractUrl: extractFxUrl,
  configPath: () => userPath(".fx", "mcp.json"),
  detect: async () => pathExists(userPath(".fx")),
});
