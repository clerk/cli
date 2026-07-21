/**
 * The stdio descriptor every client now installs: each config launches
 * `clerk mcp run`, the bridge in `../run.ts`. Centralized here so the command
 * shape and its reverse parser stay in lockstep across clients.
 *
 * No URL is embedded in the args — `clerk mcp run` resolves its target at
 * runtime via `CLERK_MCP_URL` or the active env profile. Keeping the URL out
 * of the stored config avoids confusing users who see it and wonder whether
 * they should change it.
 */

import { hasStringProp, isRecord } from "../../../lib/objects.ts";
import { getMcpUrl } from "../../../lib/environment.ts";

/** The binary clients spawn. Must be on the user's PATH. */
export const RUN_COMMAND = "clerk";

/** Args written into editor configs when installing the MCP bridge. */
export function clerkRunArgs(): string[] {
  return ["mcp", "run"];
}

/**
 * The standard `{ command, args }` bridge descriptor most clients store.
 * Clients with a different dialect (VS Code's `type: "stdio"` tag, opencode's
 * single argv array) build their own shape from `RUN_COMMAND`/`clerkRunArgs`.
 */
export function clerkRunDescriptor(): Record<string, unknown> {
  return { command: RUN_COMMAND, args: clerkRunArgs() };
}

/**
 * True when the descriptor matches the current `clerk mcp run` shape (no URL
 * in args). Used to detect already-current entries during upsert.
 */
export function isClerkRunEntry(descriptor: unknown): boolean {
  if (!isRecord(descriptor)) return false;
  const { command, args } = descriptor as { command?: unknown; args?: unknown };
  if (command !== RUN_COMMAND) return false;
  if (!Array.isArray(args) || !args.every((arg) => typeof arg === "string")) return false;
  return args[0] === "mcp" && args[1] === "run" && !args.includes("--url");
}

/**
 * `extractUrl` for the clients that share the standard bridge shape.
 *
 * Priority:
 * 1. Current format: `{ command: "clerk", args: ["mcp", "run"] }` — no URL in
 *    args; resolves to `getMcpUrl()` so list/upsert see a comparable URL.
 * 2. Direct-URL format: `{ url }` or `{ serverUrl }` — plain key lookup. Not a
 *    shape this CLI ever wrote: it round-trips entries users added by hand
 *    following the Clerk MCP docs (e.g. `{ type: "http", url }`), so those
 *    still show up in list/doctor and can be uninstalled.
 */
export function withLegacyUrl(
  descriptor: unknown,
  legacyKey: "url" | "serverUrl" = "url",
): string | undefined {
  if (isClerkRunEntry(descriptor)) return getMcpUrl();
  return hasStringProp(descriptor, legacyKey) ? descriptor[legacyKey] : undefined;
}
