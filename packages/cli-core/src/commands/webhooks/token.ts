import { log } from "../../lib/log.ts";
import { isAgent } from "../../mode.ts";
import { generateRelayToken } from "./relay-protocol.ts";
import type { WebhooksGlobalOptions } from "./shared.ts";

export type WebhooksTokenOptions = WebhooksGlobalOptions;

/**
 * Generate a valid relay token (`c_` + 10 base62 chars) for `listen --token`.
 *
 * The bare token is ALWAYS the stdout output (unless `--json`), so it pipes
 * cleanly — including under command substitution, which runs non-interactively:
 *   clerk webhooks listen --token "$(clerk webhooks token)"
 * The usage hint is stderr-only and shown in interactive (human) mode, so it
 * never pollutes the pipe.
 */
export function webhooksToken(options: WebhooksTokenOptions = {}): void {
  const token = generateRelayToken();
  if (options.json) {
    log.data(JSON.stringify({ token }));
    return;
  }
  log.data(token);
  if (!isAgent()) log.info(`Pin it: clerk webhooks listen --token ${token}`);
}
