/**
 * The stdio descriptor every client now installs: instead of pointing at the
 * remote URL (or shelling out to `npx mcp-remote`), each config launches
 * `clerk mcp run --url <url>`, the bridge in `../run.ts`. Centralized here so
 * the command shape and its reverse parser stay in lockstep across clients.
 */

import { hasStringProp } from "./make-client.ts";

/** The binary clients spawn. Must be on the user's PATH. */
export const RUN_COMMAND = "clerk";

export function clerkRunArgs(url: string): string[] {
  return ["mcp", "run", "--url", url];
}

/** Recover the URL from a `clerk mcp run --url <url>` descriptor, or undefined. */
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
 * `extractUrl` for the clients that share the new bridge shape and fall back to
 * a legacy single-key descriptor (`{ url }` for most, `{ serverUrl }` for
 * Windsurf) so existing installs still round-trip on list/uninstall.
 */
export function withLegacyUrl(
  descriptor: unknown,
  legacyKey: "url" | "serverUrl" = "url",
): string | undefined {
  return (
    extractClerkRunUrl(descriptor) ??
    (hasStringProp(descriptor, legacyKey) ? descriptor[legacyKey] : undefined)
  );
}
