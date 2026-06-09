import { getRelayEntry } from "../../lib/config.ts";
import {
  CliError,
  ERROR_CODE,
  PlapiError,
  throwUsageError,
  throwUserAbort,
} from "../../lib/errors.ts";
import { log } from "../../lib/log.ts";
import type { WebhookCursor } from "../../lib/plapi.ts";
import { isAgent } from "../../mode.ts";

export interface WebhooksGlobalOptions {
  app?: string;
  instance?: string;
  json?: boolean;
}

export const DEFAULT_PAGE_LIMIT = 100;

export function shouldOutputJson(options: { json?: boolean }): boolean {
  return Boolean(options.json) || isAgent();
}

/** Bare domain JSON on stdout — the only stdout writer for webhook commands. */
export function printJson(data: unknown): void {
  log.data(JSON.stringify(data, null, 2));
}

/** Stderr hint with the next `--iterator` value. The CLI never auto-paginates. */
export function printIteratorHint(cursor: WebhookCursor): void {
  if (cursor.has_next_page && cursor.starting_after) {
    log.info(`More available — re-run with \`--iterator ${cursor.starting_after}\``);
  }
}

/** Map a PLAPI 404 on an endpoint-addressed route to a typed CLI error. */
export async function rejectEndpointNotFound<T>(
  promise: Promise<T>,
  endpointId: string,
): Promise<T> {
  try {
    return await promise;
  } catch (error) {
    if (error instanceof PlapiError && error.status === 404) {
      throw new CliError(`No webhook endpoint with ID ${endpointId} was found.`, {
        code: ERROR_CODE.WEBHOOK_ENDPOINT_NOT_FOUND,
      });
    }
    throw error;
  }
}

/** Map a PLAPI 404 on a message-addressed route to a typed CLI error. */
export async function rejectMessageNotFound<T>(promise: Promise<T>, messageId: string): Promise<T> {
  try {
    return await promise;
  } catch (error) {
    if (error instanceof PlapiError && error.status === 404) {
      throw new CliError(`No webhook message with ID ${messageId} was found.`, {
        code: ERROR_CODE.WEBHOOK_MESSAGE_NOT_FOUND,
      });
    }
    throw error;
  }
}

/**
 * Destructive-command gate: prompt in human mode, require `--yes` in agent
 * mode. Declining the prompt aborts cleanly via UserAbortError.
 */
export async function confirmDestructive(
  message: string,
  options: { yes?: boolean },
): Promise<void> {
  if (options.yes) return;
  if (isAgent()) {
    throwUsageError("This action requires confirmation. Pass --yes to proceed in agent mode.");
  }
  const { confirm } = await import("../../lib/prompts.ts");
  const proceed = await confirm({ message, default: false });
  if (!proceed) throwUserAbort();
}

/**
 * Resolve `--endpoint`, falling back to the instance's persisted relay
 * endpoint (`trigger`, `messages`, and `replay <msg_id>` convenience rule).
 */
export async function resolveEndpointOrRelay(
  endpointFlag: string | undefined,
  instanceId: string,
): Promise<string> {
  if (endpointFlag) return endpointFlag;
  const entry = await getRelayEntry(instanceId);
  if (entry?.endpoint_id) return entry.endpoint_id;
  return throwUsageError(
    "No relay endpoint found for this instance. Run 'clerk webhooks listen' first, or pass --endpoint <ep_id>.",
  );
}

/** Split a comma-separated flag value into trimmed, non-empty entries. */
export function splitCommaList(value: string | undefined): string[] | undefined {
  if (value === undefined) return undefined;
  const parts = value
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
  return parts;
}
