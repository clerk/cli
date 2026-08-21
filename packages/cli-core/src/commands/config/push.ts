import { isHuman } from "../../mode.ts";
import { CliError, throwUsageError, throwUserAbort, ERROR_CODE } from "../../lib/errors.ts";
import { confirm } from "../../lib/prompts.ts";
import { dim, bold, red, green } from "../../lib/color.ts";
import { withSpinner, intro, outro, pausedOutro } from "../../lib/spinner.ts";
import { closeStatusForError } from "../../lib/signals.ts";
import { isInsideGutter, log } from "../../lib/log.ts";
import { keylessCopy } from "../../lib/copy.ts";
import { NEXT_STEPS, printNextSteps } from "../../lib/next-steps.ts";
import { resolveInstanceTarget } from "../../lib/keyless-target.ts";
import type { KeylessWriteVerification } from "./keyless.ts";
import {
  assertPayloadWritable,
  LOCAL_DRY_RUN_MESSAGE,
  readInstanceConfig,
  supportsServerDryRun,
  writeInstanceConfig,
  type ConfigMethod,
} from "./io.ts";

interface ConfigPushOptions {
  app?: string;
  instance?: string;
  file?: string;
  json?: string;
  dryRun?: boolean;
  yes?: boolean;
  destructive?: boolean;
}

type Operation = {
  method: ConfigMethod;
  verb: string;
  warning?: string;
  title: string;
};

const PUT_OP: Operation = {
  method: "PUT",
  verb: "Replacing",
  warning: "This will overwrite the entire instance configuration.",
  title: "Replacing configuration",
};

const PATCH_OP: Operation = {
  method: "PATCH",
  verb: "Updating",
  title: "Patching configuration",
};

export async function configPut(options: ConfigPushOptions): Promise<void> {
  return configPush(options, PUT_OP);
}

export async function configPatch(options: ConfigPushOptions): Promise<void> {
  return configPush(options, PATCH_OP);
}

async function configPush(options: ConfigPushOptions, op: Operation): Promise<void> {
  const target = await resolveInstanceTarget(options);

  if (target.kind === "keyless" && op.method === "PUT") {
    throw new CliError(keylessCopy.putNeedsClaimedApplication(), {
      code: ERROR_CODE.AUTH_REQUIRED,
    });
  }

  const configPayload = parsePayload(await readInput(options));
  assertPayloadWritable(target, configPayload);

  const shouldWrap = !isInsideGutter();
  if (shouldWrap) intro(op.title);
  let closeStatus: "success" | "failed" | "paused" | undefined;

  try {
    const currentConfig = await withSpinner("Fetching current config...", () =>
      readInstanceConfig(target, configPayload),
    );
    delete currentConfig.config_version;

    const isPatch = op.method === "PATCH";

    if (!hasConfigChanges(currentConfig, configPayload, isPatch)) {
      log.info(options.dryRun ? "[dry-run] No changes detected" : "No changes detected");
      closeStatus = "success";
      return;
    }

    const prefix = options.dryRun ? `[dry-run] Proposing ${op.method}` : op.verb;
    log.info(`\n${prefix} config on ${target.label}:\n`);
    printDiff(currentConfig, configPayload, isPatch);

    if (options.dryRun && !supportsServerDryRun(target)) {
      log.success(LOCAL_DRY_RUN_MESSAGE);
      printNextSteps(NEXT_STEPS.CONFIG_DRY_RUN_PATCH);
      closeStatus = "success";
      return;
    }

    if (!options.dryRun && isHuman() && !options.yes) {
      if (op.warning) {
        log.warn(`${op.warning}`);
      }
      const ok = await confirm({ message: "Proceed?" });
      if (!ok) {
        throwUserAbort();
      }
    }

    const spinnerMsg = options.dryRun
      ? `[dry-run] Validating config on ${target.label}...`
      : `${op.verb} config on ${target.label}...`;
    const result = await withSpinner(spinnerMsg, () =>
      writeInstanceConfig(target, configPayload, {
        method: op.method,
        destructive: options.destructive,
        dryRun: options.dryRun,
        failureContext: "Failed to push config",
      }),
    );
    log.data(JSON.stringify(result.body, null, 2));
    if (options.dryRun) {
      log.success("[dry-run] Validation passed — no changes applied");
      printNextSteps(
        op.method === "PATCH" ? NEXT_STEPS.CONFIG_DRY_RUN_PATCH : NEXT_STEPS.CONFIG_DRY_RUN_PUT,
      );
    } else {
      reportWriteOutcome(result.verification, "Config pushed successfully");
      printNextSteps(NEXT_STEPS.CONFIG_PUSH);
    }
    closeStatus = "success";
  } catch (error) {
    closeStatus = closeStatusForError(error);
    throw error;
  } finally {
    if (shouldWrap) {
      if (closeStatus === "paused") {
        pausedOutro();
      } else if (closeStatus === "failed") {
        await outro("Failed");
      } else if (closeStatus === "success") {
        await outro();
      }
    }
  }
}

/** Parses the raw input into a config object, rejecting anything else. */
function parsePayload(rawInput: string): Record<string, unknown> {
  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(rawInput);
  } catch {
    throwUsageError(
      "Invalid JSON input. Please provide valid JSON.",
      undefined,
      ERROR_CODE.INVALID_JSON,
    );
  }

  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    throwUsageError("Config must be a JSON object.", undefined, ERROR_CODE.INVALID_JSON);
  }

  // Strip config_version — it's returned by pull but not accepted by the backend
  delete payload.config_version;
  return payload;
}

export async function readInput(options: { file?: string; json?: string }): Promise<string> {
  if (options.json) {
    return options.json;
  }

  if (options.file) {
    const file = Bun.file(options.file);
    if (!(await file.exists())) {
      throwUsageError(`File not found: ${options.file}`, undefined, ERROR_CODE.FILE_NOT_FOUND);
    }
    return file.text();
  }

  if (!process.stdin.isTTY) {
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) {
      chunks.push(Buffer.from(chunk));
    }
    const text = Buffer.concat(chunks).toString("utf-8").trim();
    if (!text) {
      throwUsageError("No input received from stdin");
    }
    return text;
  }

  throwUsageError(
    "No input provided. Use --file <path>, --json <string>, or pipe JSON to stdin.\n" +
      "  Example: clerk config patch --file config.json\n" +
      '  Example: clerk config patch --json \'{"session":{"lifetime":3600}}\'\n' +
      "  Example: cat config.json | clerk config patch",
  );
}

type Change = { path: string; oldVal?: unknown; newVal?: unknown };

/**
 * Recursively collects leaf-level differences between two values.
 *
 * When `patchMode` is true, only keys present in the new (payload) side
 * are walked, so extra keys on the old side are ignored.
 * When false (PUT), keys from both sides are walked so deletions are visible.
 */
function collectChanges(
  oldObj: unknown,
  newObj: unknown,
  path: string,
  out: Change[],
  patchMode: boolean,
): void {
  if (JSON.stringify(oldObj) === JSON.stringify(newObj)) return;

  const bothObjects =
    oldObj != null &&
    newObj != null &&
    typeof oldObj === "object" &&
    typeof newObj === "object" &&
    !Array.isArray(oldObj) &&
    !Array.isArray(newObj);

  if (bothObjects) {
    const keys = patchMode
      ? Object.keys(newObj as Record<string, unknown>)
      : [
          ...new Set([
            ...Object.keys(oldObj as Record<string, unknown>),
            ...Object.keys(newObj as Record<string, unknown>),
          ]),
        ];
    for (const key of keys) {
      collectChanges(
        (oldObj as Record<string, unknown>)[key],
        (newObj as Record<string, unknown>)[key],
        path ? `${path}.${key}` : key,
        out,
        patchMode,
      );
    }
    return;
  }

  out.push({ path, oldVal: oldObj, newVal: newObj });
}

function topLevelKeys(
  current: Record<string, unknown>,
  payload: Record<string, unknown>,
  patchMode: boolean,
): string[] {
  return patchMode
    ? Object.keys(payload)
    : [...new Set([...Object.keys(current), ...Object.keys(payload)])];
}

/**
 * Returns true if the payload would change any config values.
 * Uses the same recursive walker as printDiff so partial nested
 * payloads (e.g. patching only session.lifetime) are compared correctly.
 */
export function hasConfigChanges(
  current: Record<string, unknown>,
  payload: Record<string, unknown>,
  patchMode: boolean,
): boolean {
  for (const key of topLevelKeys(current, payload, patchMode)) {
    const changes: Change[] = [];
    collectChanges(current[key], payload[key], "", changes, patchMode);
    if (changes.length > 0) return true;
  }
  return false;
}

/**
 * Prints a diff showing only leaf values that actually changed,
 * grouped by top-level config key.
 *
 * When `patchMode` is true, only keys present in the payload are walked.
 * When false (PUT), all keys from both current and payload are walked
 * so removed keys are visible too.
 */
export function printDiff(
  current: Record<string, unknown>,
  payload: Record<string, unknown>,
  patchMode: boolean,
): void {
  const keys = topLevelKeys(current, payload, patchMode);

  for (const key of keys) {
    const changes: Change[] = [];
    collectChanges(current[key], payload[key], "", changes, patchMode);
    if (changes.length === 0) continue;

    log.raw(`  ${key}:`);
    for (const { path, oldVal, newVal } of changes) {
      if (path) {
        log.raw(`    ${path}:`);
      }
      const indent = path ? "      " : "    ";
      const useColor = isHuman();
      if (oldVal !== undefined) {
        const line = `${indent}- ${JSON.stringify(oldVal)}`;
        log.raw(useColor ? dim(red(line)) : line);
      }
      if (newVal !== undefined) {
        const line = `${indent}+ ${JSON.stringify(newVal)}`;
        log.raw(useColor ? bold(green(line)) : line);
      }
    }
  }
}

/**
 * Prints what actually took after a write, instead of an unconditional
 * success line. Account-mode writes have no `verification` — the Platform
 * API's response body is the config document, trusted outright. A keyless
 * write only gets a 200/204 for "the request was accepted": Clerk's Backend
 * API silently drops fields it doesn't recognize inside a group rather than
 * rejecting them, so dropped fields are named instead of folded into a
 * "successfully" that isn't true for them.
 */
export function reportWriteOutcome(
  verification: KeylessWriteVerification | undefined,
  successMessage: string,
): void {
  if (!verification) {
    log.success(successMessage);
    return;
  }

  const { droppedFields, unverifiableGroups } = verification;

  if (droppedFields.length > 0) {
    const [one, them] =
      droppedFields.length === 1 ? ["This field", "it"] : ["These fields", "them"];
    log.warn(
      `${one} didn't come back in Clerk's Backend API response: ${droppedFields.join(", ")}. ` +
        `The API ignores field names it doesn't recognise rather than rejecting them, so check ${them} for a typo against the diff above.`,
    );
  }

  // Always close with a success line: the write was accepted, and a run that
  // ends on a warning alone reads as a failure that never happened.
  log.success(
    unverifiableGroups.length > 0
      ? `${successMessage} — ${unverifiableGroups.join(", ")} answered with no body, so ${unverifiableGroups.length === 1 ? "that group" : "those groups"} couldn't be confirmed`
      : successMessage,
  );
}
