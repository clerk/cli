/**
 * Aggregate Clerk MCP entries across every supported client.
 *
 * Deliberately light on imports (just the client registry) so it can be reused
 * by `clerk doctor`'s MCP check without dragging in `shared.ts`'s heavier graph
 * (env profiles, interactive prompts) and the module cycle that comes with it.
 * Each client's `list` already swallows-and-warns on its own malformed config,
 * so a single bad client can't sink the aggregate.
 */

import { errorMessage } from "../../lib/errors.ts";
import { log } from "../../lib/log.ts";
import { CLIENTS } from "./clients/registry.ts";
import type { ListEntry } from "./clients/types.ts";

export async function collectEntries(cwd: string): Promise<ListEntry[]> {
  const settled = await Promise.allSettled(CLIENTS.map((c) => c.list(cwd)));
  return settled.flatMap((outcome, i) => {
    if (outcome.status === "fulfilled") return outcome.value;
    // A client's own `list` already warns on its malformed config; reaching the
    // rejected branch means an unexpected error (e.g. an unreadable file), so
    // surface it instead of silently dropping that client.
    log.warn(
      `${CLIENTS[i]!.displayName}: could not read MCP config — ${errorMessage(outcome.reason)}`,
    );
    return [];
  });
}
