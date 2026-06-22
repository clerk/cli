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

import { getMcpUrl } from "../../../lib/environment.ts";
import { hasStringProp } from "./make-client.ts";

/** The binary clients spawn. Must be on the user's PATH. */
export const RUN_COMMAND = "clerk";

/** Args written into editor configs when installing the MCP bridge. */
export function clerkRunArgs(): string[] {
  return ["mcp", "run"];
}

/**
 * Return the URL embedded in a legacy `clerk mcp run --url <url>` descriptor,
 * or undefined. Only used to migrate entries written by an older CLI version.
 */
export function extractClerkRunUrl(descriptor: unknown): string | undefined {
  if (typeof descriptor !== "object" || descriptor === null) return undefined;
  const { command, args } = descriptor as { command?: unknown; args?: unknown };
  if (command !== RUN_COMMAND) return undefined;
  if (!Array.isArray(args) || !args.every((arg) => typeof arg === "string")) return undefined;
  const flagIndex = args.indexOf("--url");
  if (flagIndex !== -1 && args[flagIndex + 1]) return args[flagIndex + 1];
  const inline = args.find((arg: string) => arg.startsWith("--url="));
  // `|| undefined` so an empty `--url=` reports "absent", matching the contract.
  return inline ? inline.slice("--url=".length) || undefined : undefined;
}

/**
 * True when the descriptor matches the current `clerk mcp run` shape (no URL
 * in args). Used to detect already-current entries during upsert.
 */
export function isClerkRunEntry(descriptor: unknown): boolean {
  if (typeof descriptor !== "object" || descriptor === null) return false;
  const { command, args } = descriptor as { command?: unknown; args?: unknown };
  if (command !== RUN_COMMAND) return false;
  if (!Array.isArray(args) || !args.every((arg) => typeof arg === "string")) return false;
  return args[0] === "mcp" && args[1] === "run" && !args.includes("--url");
}

/**
 * `extractUrl` for the clients that share the new bridge shape and fall back to
 * legacy descriptor shapes so existing installs still round-trip on
 * list/uninstall.
 *
 * Priority:
 * 1. Current format: `{ command: "clerk", args: ["mcp", "run"] }` — no URL in
 *    args; resolves to `getMcpUrl()` so list/upsert see a comparable URL.
 * 2. Legacy v1 format: `{ command: "clerk", args: ["mcp", "run", "--url", …] }` —
 *    URL extracted from the `--url` arg.
 * 3. Legacy v0 format: `{ url }` or `{ serverUrl }` — plain key lookup.
 */
export function withLegacyUrl(
  descriptor: unknown,
  legacyKey: "url" | "serverUrl" = "url",
): string | undefined {
  if (isClerkRunEntry(descriptor)) return getMcpUrl();
  return (
    extractClerkRunUrl(descriptor) ??
    (hasStringProp(descriptor, legacyKey) ? descriptor[legacyKey] : undefined)
  );
}
