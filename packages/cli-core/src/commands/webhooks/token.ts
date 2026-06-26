import { log } from "../../lib/log.ts";
import { outro } from "../../lib/spinner.ts";
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
 * In interactive (human) mode we also print an animated "Next steps" block on
 * stderr so the pinning command is explicit; it never pollutes the stdout pipe.
 */
export async function webhooksToken(options: WebhooksTokenOptions = {}): Promise<void> {
  const token = generateRelayToken();
  if (options.json) {
    log.data(JSON.stringify({ token }));
    return;
  }
  log.data(token);
  if (isAgent()) return;
  await outro([
    `Pin it: clerk webhooks listen --token ${token} --forward-to <url>`,
    "Register the Relay URL it prints as an endpoint in your Clerk Dashboard",
  ]);
}
