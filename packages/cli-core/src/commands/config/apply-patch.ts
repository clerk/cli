import { throwUserAbort } from "../../lib/errors.ts";
import { withSpinner } from "../../lib/spinner.ts";
import { confirm } from "../../lib/prompts.ts";
import { isHuman } from "../../mode.ts";
import { log } from "../../lib/log.ts";
import { hasConfigChanges, printDiff, reportWriteOutcome } from "./push.ts";
import type { InstanceTarget } from "../../lib/keyless-target.ts";
import {
  assertPayloadWritable,
  LOCAL_DRY_RUN_MESSAGE,
  readInstanceConfig,
  supportsServerDryRun,
  writeInstanceConfig,
} from "./io.ts";

export interface ApplyPatchOptions {
  target: InstanceTarget;
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
export async function applyConfigPatch(opts: ApplyPatchOptions): Promise<boolean> {
  const { target, payload, verb, successMessage, failureContext, yes, dryRun, warning } = opts;

  assertPayloadWritable(target, payload);

  const current =
    opts.currentConfig ??
    (await withSpinner("Fetching current config...", () => readInstanceConfig(target, payload)));

  if (!hasConfigChanges(current, payload, true)) {
    log.info(dryRun ? "[dry-run] No changes detected" : "No changes detected");
    return false;
  }

  const headline = dryRun
    ? `[dry-run] Proposing PATCH on ${target.label}:`
    : `${verb} on ${target.label}:`;
  log.info(`\n${headline}\n`);
  printDiff(current, payload, true);

  // Warning prints whenever it's set, even when --yes or agent mode skips the
  // prompt — the warning is an audit signal, not a confirmation cue.
  if (warning) log.warn(warning);

  if (dryRun && !supportsServerDryRun(target)) {
    log.success(LOCAL_DRY_RUN_MESSAGE);
    return true;
  }

  if (!dryRun && isHuman() && !yes) {
    const ok = await confirm({ message: "Proceed?" });
    if (!ok) throwUserAbort();
  }

  const spinnerMsg = dryRun
    ? `[dry-run] Validating config on ${target.label}...`
    : `${verb} on ${target.label}...`;
  const result = await withSpinner(spinnerMsg, () =>
    writeInstanceConfig(target, payload, { method: "PATCH", dryRun, failureContext }),
  );

  log.debug(`config: ${JSON.stringify(result.body)}`);
  if (dryRun) {
    log.success("[dry-run] Validation passed — no changes applied");
  } else {
    reportWriteOutcome(result.verification, successMessage);
  }
  return true;
}
