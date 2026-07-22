/**
 * Writes opencode's user-global `opencode.json` directly (XDG config dir on
 * every platform). opencode ships an `mcp add` command, but it is an
 * interactive wizard with no flag-driven path for stdio servers — under our
 * closed-stdin guarantee it would EOF-error — and there is no removal command
 * at all, so both mutations use the documented manual path: the config file.
 *
 * opencode's dialect differs from the common `{ command, args }` shape:
 * entries live under top-level `mcp`, and a stdio server is
 * `{ type: "local", command: ["clerk", "mcp", "run"] }` (single argv array).
 */

import { isRecord } from "../../../lib/objects.ts";
import { getMcpUrl } from "../../../lib/environment.ts";
import { clerkRunArgs, RUN_COMMAND } from "./clerk-run.ts";
import { makeJsonClient } from "./make-client.ts";
import { pathExists, xdgConfigPath } from "./paths.ts";

// opencode's bridge dialect: a single argv array instead of `{ command, args }`.
function isOpencodeBridge(descriptor: unknown): boolean {
  if (!isRecord(descriptor)) return false;
  const command = (descriptor as { command?: unknown }).command;
  return (
    Array.isArray(command) &&
    command[0] === RUN_COMMAND &&
    command[1] === "mcp" &&
    command[2] === "run"
  );
}

function extractOpencodeUrl(descriptor: unknown): string | undefined {
  if (!isRecord(descriptor)) return undefined;
  const url = (descriptor as { url?: unknown }).url;
  // Remote entries (`{ type: "remote", url }`) carry their URL directly.
  if (typeof url === "string") return url;
  // Our local bridge entry: the URL is resolved at runtime, so report the
  // currently-resolved target (same as the other clients' bridge entries).
  return isOpencodeBridge(descriptor) ? getMcpUrl() : undefined;
}

export const opencodeClient = makeJsonClient({
  id: "opencode",
  displayName: "opencode",
  scope: "user",
  activation: "Restart opencode (`clerk` must be on your PATH).",
  topKey: "mcp",
  encode: () => ({ type: "local", command: [RUN_COMMAND, ...clerkRunArgs()] }),
  extractUrl: extractOpencodeUrl,
  isOurs: isOpencodeBridge,
  configPath: () => xdgConfigPath("opencode", "opencode.json"),
  detect: () => pathExists(xdgConfigPath("opencode")),
});
