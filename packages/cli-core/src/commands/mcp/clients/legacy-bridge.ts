/**
 * Recognizes entries left behind by clerk 3.x, which installed a
 * `clerk mcp run` stdio bridge into every client except fx. clerk 4.0 removed
 * the bridge in favor of native URL entries, so nothing writes this shape
 * anymore — `list`, `uninstall`, and `doctor` use it only to find stale
 * installs and point the user at `clerk mcp install`, which replaces them.
 */

import { isRecord } from "../../../lib/objects.ts";

/** The binary the legacy bridge entries launch. */
const LEGACY_COMMAND = "clerk";

function isBridgeArgv(argv: readonly unknown[]): boolean {
  return argv[0] === "mcp" && argv[1] === "run";
}

/**
 * True for a legacy `clerk mcp run` descriptor in any dialect the 3.x CLI
 * wrote: the standard `{ command: "clerk", args: ["mcp", "run"] }` (VS Code
 * adds a `type: "stdio"` tag) and opencode's single argv array
 * `{ type: "local", command: ["clerk", "mcp", "run"] }`.
 */
export function isLegacyBridgeEntry(descriptor: unknown): boolean {
  if (!isRecord(descriptor)) return false;
  const { command, args } = descriptor as { command?: unknown; args?: unknown };
  if (Array.isArray(command)) {
    return command[0] === LEGACY_COMMAND && isBridgeArgv(command.slice(1));
  }
  if (command !== LEGACY_COMMAND) return false;
  return Array.isArray(args) && isBridgeArgv(args);
}
