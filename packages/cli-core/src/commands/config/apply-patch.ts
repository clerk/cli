import { fetchInstanceConfig, patchInstanceConfig } from "../../lib/plapi.ts";
import { throwUserAbort, withApiContext } from "../../lib/errors.ts";
import { withSpinner } from "../../lib/spinner.ts";
import { confirm } from "../../lib/prompts.ts";
import { isHuman } from "../../mode.ts";
import { log } from "../../lib/log.ts";
import { hasConfigChanges, printDiff } from "./push.ts";

export interface ApplyPatchOptions {
  ctx: { appId: string; instanceId: string; appLabel: string; instanceLabel: string };
  payload: Record<string, unknown>;
  /** Verb shown in dry-run/spinner headlines, e.g. "Enabling organizations". */
  verb: string;
  /** Final success line in non-dry-run mode, e.g. "Organizations enabled". */
  successMessage: string;
  /** Context attached to API errors when the PATCH fails. */
  failureContext: string;
  /** Skip-confirmation flag from the calling command. */
  yes?: boolean;
  /** Preview-only flag from the calling command. */
  dryRun?: boolean;
  /** Optional human-mode warning printed just before the confirm prompt. */
  warning?: string;
  /**
   * Pre-fetched current config (e.g. when the caller already inspected it to
   * decide on a warning). Skips the extra GET round-trip.
   */
  currentConfig?: Record<string, unknown>;
}

/**
 * Shared flow for the `enable`/`disable` shortcut commands: fetch current
 * config, diff against the proposed patch, confirm in human mode, and apply.
 *
 * Mirrors the safety story from `clerk config patch` (see push.ts) so the
 * shortcut commands don't regress on diff/dry-run/confirmation.
 */
export async function applyConfigPatch(opts: ApplyPatchOptions): Promise<void> {
  const { ctx, payload, verb, successMessage, failureContext, yes, dryRun, warning } = opts;

  const current =
    opts.currentConfig ??
    (await withSpinner("Fetching current config...", () =>
      withApiContext(fetchInstanceConfig(ctx.appId, ctx.instanceId), "Failed to fetch config"),
    ));

  if (!hasConfigChanges(current, payload, true)) {
    log.info(dryRun ? "[dry-run] No changes detected" : "No changes detected");
    return;
  }

  const headline = dryRun
    ? `[dry-run] Proposing PATCH on ${ctx.appLabel} (${ctx.instanceLabel}):`
    : `${verb} on ${ctx.appLabel} (${ctx.instanceLabel}):`;
  log.info(`\n${headline}\n`);
  printDiff(current, payload, true);

  if (!dryRun && isHuman() && !yes) {
    if (warning) log.warn(warning);
    const ok = await confirm({ message: "Proceed?" });
    if (!ok) throwUserAbort();
  }

  const spinnerMsg = dryRun
    ? `[dry-run] Validating config on ${ctx.appLabel} (${ctx.instanceLabel})...`
    : `${verb} on ${ctx.appLabel} (${ctx.instanceLabel})...`;
  const result = await withSpinner(spinnerMsg, () =>
    withApiContext(
      patchInstanceConfig(ctx.appId, ctx.instanceId, payload, { dryRun }),
      dryRun ? "Dry-run failed" : failureContext,
    ),
  );

  log.debug(`plapi: ${JSON.stringify(result)}`);
  log.success(dryRun ? "[dry-run] Validation passed — no changes applied" : successMessage);
}
