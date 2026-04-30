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
  verb: string;
  successMessage: string;
  failureContext: string;
  yes?: boolean;
  dryRun?: boolean;
  warning?: string;
  /** Pre-fetched current config; skips the extra GET when caller already has it. */
  currentConfig?: Record<string, unknown>;
}

/** Fetch + diff + confirm + PATCH, matching `clerk config patch` semantics. */
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
