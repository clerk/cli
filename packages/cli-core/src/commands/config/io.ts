/**
 * Reading and writing instance configuration, whichever way the instance is
 * addressed.
 *
 * This is the only place that knows an account target and a keyless target
 * reach different APIs. Callers take an `InstanceTarget`, ask for a read or a
 * write, and never branch on `kind` themselves.
 */

import { withApiContext } from "../../lib/errors.ts";
import type { InstanceTarget } from "../../lib/keyless-target.ts";
import { fetchInstanceConfig, patchInstanceConfig, putInstanceConfig } from "../../lib/plapi.ts";
import {
  assertKeylessPayload,
  patchKeylessConfig,
  readCurrentGroups,
  type KeylessWriteVerification,
} from "./keyless.ts";

export type ConfigMethod = "PUT" | "PATCH";

export interface WriteResult {
  /** What the API reported back — printed to the user as-is. */
  body: Record<string, unknown>;
  /**
   * Only present for a keyless write. An account write's response body IS the
   * config document, trusted outright; a keyless write only gets a 200/204
   * meaning "request accepted", so what actually landed is checked separately.
   */
  verification?: KeylessWriteVerification;
}

/**
 * Rejects a payload the target can't accept, before any diff is printed or any
 * prompt is shown. Only the keyless path constrains the payload — the account
 * API validates the document server-side.
 */
export function assertPayloadWritable(
  target: InstanceTarget,
  payload: Record<string, unknown>,
): void {
  if (target.kind === "keyless") assertKeylessPayload(payload);
}

/**
 * Current configuration, limited to what the write will touch.
 *
 * The account API returns one document regardless of `scope`. The keyless API
 * has no document, so `scope` selects which resources to read — passing the
 * pending payload keeps the read to the groups being diffed.
 */
export async function readInstanceConfig(
  target: InstanceTarget,
  scope: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  if (target.kind === "keyless") return readCurrentGroups(target.keyless, scope);

  return withApiContext(
    fetchInstanceConfig(target.ctx.appId, target.ctx.instanceId),
    "Failed to fetch current config",
  );
}

/**
 * Server-side dry run is a Platform API feature. The Backend API has no
 * equivalent, so a keyless preview can only be produced locally.
 */
export function supportsServerDryRun(target: InstanceTarget): boolean {
  return target.kind === "account";
}

export const LOCAL_DRY_RUN_MESSAGE = "[dry-run] Nothing sent — no changes applied";

export async function writeInstanceConfig(
  target: InstanceTarget,
  payload: Record<string, unknown>,
  options: {
    method: ConfigMethod;
    destructive?: boolean;
    dryRun?: boolean;
    failureContext: string;
  },
): Promise<WriteResult> {
  if (target.kind === "keyless") {
    // PUT is rejected before reaching here: there is no full document to
    // replace when the instance is addressed by its own key. The payload was
    // validated by `assertPayloadWritable` before the diff was shown.
    const { applied, verification } = await patchKeylessConfig(
      target.keyless,
      payload as Record<string, Record<string, unknown>>,
    );
    return { body: applied, verification };
  }

  const apiFn = options.method === "PUT" ? putInstanceConfig : patchInstanceConfig;
  const body = await withApiContext(
    apiFn(target.ctx.appId, target.ctx.instanceId, payload, {
      destructive: options.destructive,
      dryRun: options.dryRun,
    }),
    options.dryRun ? "Dry-run failed" : options.failureContext,
  );
  return { body };
}
