import { resolveAppContext } from "../../lib/config.ts";
import { fetchInstanceConfig, putInstanceConfig, patchInstanceConfig } from "../../lib/plapi.ts";
import { isHuman } from "../../mode.ts";
import { throwUsageError, throwUserAbort, withApiContext, ERROR_CODE } from "../../lib/errors.ts";
import { confirm } from "../../lib/prompts.ts";
import { dim, bold, red, green } from "../../lib/color.ts";
import { withSpinner, intro, outro } from "../../lib/spinner.ts";
import { log } from "../../lib/log.ts";
import { NEXT_STEPS, printNextSteps } from "../../lib/next-steps.ts";

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
  method: "PUT" | "PATCH";
  verb: string;
  warning?: string;
  apiFn: (
    appId: string,
    instId: string,
    config: Record<string, unknown>,
    options?: { destructive?: boolean; dryRun?: boolean },
  ) => Promise<Record<string, unknown>>;
  title: string;
};

const PUT_OP: Operation = {
  method: "PUT",
  verb: "Replacing",
  warning: "This will overwrite the entire instance configuration.",
  apiFn: putInstanceConfig,
  title: "Replacing configuration",
};

const PATCH_OP: Operation = {
  method: "PATCH",
  verb: "Updating",
  apiFn: patchInstanceConfig,
  title: "Patching configuration",
};

export async function configPut(options: ConfigPushOptions): Promise<void> {
  return configPush(options, PUT_OP);
}

export async function configPatch(options: ConfigPushOptions): Promise<void> {
  return configPush(options, PATCH_OP);
}

async function configPush(options: ConfigPushOptions, op: Operation): Promise<void> {
  const ctx = await resolveAppContext(options);
  const rawInput = await readInput(options);

  let configPayload: Record<string, unknown>;
  try {
    configPayload = JSON.parse(rawInput);
  } catch {
    throwUsageError(
      "Invalid JSON input. Please provide valid JSON.",
      undefined,
      ERROR_CODE.INVALID_JSON,
    );
  }

  if (typeof configPayload !== "object" || configPayload === null || Array.isArray(configPayload)) {
    throwUsageError("Config must be a JSON object.", undefined, ERROR_CODE.INVALID_JSON);
  }

  // Strip config_version — it's returned by pull but not accepted by the backend
  delete configPayload.config_version;

  intro(op.title);

  const currentConfig = await withSpinner("Fetching current config...", () =>
    withApiContext(
      fetchInstanceConfig(ctx.appId, ctx.instanceId),
      "Failed to fetch current config",
    ),
  );
  delete currentConfig.config_version;

  const isPatch = op.method === "PATCH";

  if (!hasConfigChanges(currentConfig, configPayload, isPatch)) {
    log.info(options.dryRun ? "[dry-run] No changes detected" : "No changes detected");
    outro();
    return;
  }

  const prefix = options.dryRun ? `[dry-run] Proposing ${op.method}` : op.verb;
  log.info(`\n${prefix} config on ${ctx.appLabel} (${ctx.instanceLabel}):\n`);
  printDiff(currentConfig, configPayload, isPatch);

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
    ? `[dry-run] Validating config on ${ctx.appLabel} (${ctx.instanceLabel})...`
    : `${op.verb} config on ${ctx.appLabel} (${ctx.instanceLabel})...`;
  const result = await withSpinner(spinnerMsg, () =>
    withApiContext(
      op.apiFn(ctx.appId, ctx.instanceId, configPayload, {
        destructive: options.destructive,
        dryRun: options.dryRun,
      }),
      options.dryRun ? "Dry-run failed" : "Failed to push config",
    ),
  );
  log.data(JSON.stringify(result, null, 2));
  log.success(
    options.dryRun
      ? "[dry-run] Validation passed — no changes applied"
      : "Config pushed successfully",
  );
  if (options.dryRun) {
    printNextSteps(
      op.method === "PATCH" ? NEXT_STEPS.CONFIG_DRY_RUN_PATCH : NEXT_STEPS.CONFIG_DRY_RUN_PUT,
    );
  } else {
    printNextSteps(NEXT_STEPS.CONFIG_PUSH);
  }
  outro();
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
