/**
 * Aggregate Clerk MCP entries across every supported client.
 *
 * Deliberately light on imports (just the client registry) so it can be reused
 * by `clerk doctor`'s MCP check without dragging in `shared.ts`'s heavier graph
 * (env profiles, interactive prompts) and the module cycle that comes with it.
 * Clients settle independently, so a single bad config can't sink the
 * aggregate — but it is reported as a failure, not folded into "no entries",
 * so callers like `doctor` can tell a corrupt config apart from a clean slate.
 */

import { errorMessage } from "../../lib/errors.ts";
import { log } from "../../lib/log.ts";
import { CLIENTS } from "./clients/registry.ts";
import type { ClientId, ListEntry } from "./clients/types.ts";

/** A client whose config exists but couldn't be read or parsed. */
export interface CollectFailure {
  client: ClientId;
  displayName: string;
  message: string;
}

export interface CollectResult {
  entries: ListEntry[];
  failures: CollectFailure[];
}

export async function collectEntries(cwd: string): Promise<CollectResult> {
  const settled = await Promise.allSettled(CLIENTS.map((c) => c.list(cwd)));
  const entries: ListEntry[] = [];
  const failures: CollectFailure[] = [];
  for (const [i, outcome] of settled.entries()) {
    if (outcome.status === "fulfilled") {
      entries.push(...outcome.value);
      continue;
    }
    const client = CLIENTS[i]!;
    const message = errorMessage(outcome.reason);
    failures.push({ client: client.id, displayName: client.displayName, message });
    log.warn(`${client.displayName}: could not read MCP config — ${message}`);
  }
  return { entries, failures };
}
