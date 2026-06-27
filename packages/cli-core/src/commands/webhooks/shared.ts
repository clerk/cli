import { isAgent } from "../../mode.ts";

/** Flags inherited from the `webhooks` group. V1 only carries `--json`. */
export interface WebhooksGlobalOptions {
  json?: boolean;
}

/** JSON on stdout when `--json` is set or we're in agent mode. */
export function shouldOutputJson(options: { json?: boolean }): boolean {
  return Boolean(options.json) || isAgent();
}
