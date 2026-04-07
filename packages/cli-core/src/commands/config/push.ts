import type { Need } from "../../lib/deps.ts";
import { throwUsageError, throwUserAbort, withApiContext, ERROR_CODE } from "../../lib/errors.ts";
import { dim, bold, red, green } from "../../lib/color.ts";

interface ConfigPushOptions {
  app?: string;
  instance?: string;
  file?: string;
  json?: string;
  dryRun?: boolean;
  yes?: boolean;
  destructive?: boolean;
}

/**
 * Slice for the shared push pipeline. `configPatch` and `configPut` both
 * funnel through `runConfigPush` which is the source of truth for these
 * dependencies.
 */
export type ConfigPushDeps = Need<{
  plapi: "fetchInstanceConfig" | "putInstanceConfig" | "patchInstanceConfig";
  configStore: "resolveAppContext";
  spinner: "withSpinner";
  prompts: "confirm";
  mode: "isHuman";
  log: "info" | "warn" | "data";
}>;

export type ConfigPatchDeps = ConfigPushDeps;
export type ConfigPutDeps = ConfigPushDeps;

type Operation = {
  method: "PUT" | "PATCH";
  verb: string;
  warning?: string;
  apiFn: (
    deps: ConfigPushDeps,
    appId: string,
    instId: string,
    config: Record<string, unknown>,
    options?: { destructive?: boolean },
  ) => Promise<Record<string, unknown>>;
};

const PUT_OP: Operation = {
  method: "PUT",
  verb: "Replacing",
  warning: "This will overwrite the entire instance configuration.",
  apiFn: (deps, appId, instId, config, options) =>
    deps.plapi.putInstanceConfig(appId, instId, config, options),
};

const PATCH_OP: Operation = {
  method: "PATCH",
  verb: "Updating",
  apiFn: (deps, appId, instId, config, options) =>
    deps.plapi.patchInstanceConfig(appId, instId, config, options),
};

export async function configPut(deps: ConfigPutDeps, options: ConfigPushOptions): Promise<void> {
  return runConfigPush(deps, options, PUT_OP);
}

export async function configPatch(
  deps: ConfigPatchDeps,
  options: ConfigPushOptions,
): Promise<void> {
  return runConfigPush(deps, options, PATCH_OP);
}

async function runConfigPush(
  deps: ConfigPushDeps,
  options: ConfigPushOptions,
  op: Operation,
): Promise<void> {
  const ctx = await deps.configStore.resolveAppContext(options);
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

  // Strip config_version, it's returned by pull but not accepted by the backend
  delete configPayload.config_version;

  if (options.dryRun) {
    deps.log.info(`[dry-run] Would ${op.method} config on ${ctx.appLabel} (${ctx.instanceLabel}):`);
    deps.log.data(JSON.stringify(configPayload, null, 2));
    return;
  }

  const currentConfig = await deps.spinner.withSpinner("Fetching current config...", () =>
    withApiContext(
      deps.plapi.fetchInstanceConfig(ctx.appId, ctx.instanceId),
      "Failed to fetch current config",
    ),
  );

  // Strip config_version from current config to match the payload normalization above
  delete currentConfig.config_version;

  const isPatch = op.method === "PATCH";
  const hasChanges = hasConfigChanges(currentConfig, configPayload, isPatch);

  if (!hasChanges) {
    deps.log.info("No changes detected");
    return;
  }

  deps.log.info(`\n${op.verb} config on ${ctx.appLabel} (${ctx.instanceLabel}):\n`);
  printDiff(deps, currentConfig, configPayload, isPatch, deps.mode.isHuman());

  if (deps.mode.isHuman() && !options.yes) {
    if (op.warning) {
      deps.log.warn(op.warning);
    }
    const ok = await deps.prompts.confirm({ message: "Proceed?" });
    if (!ok) {
      throwUserAbort();
    }
  }

  const result = await deps.spinner.withSpinner(
    `${op.verb} config on ${ctx.appLabel} (${ctx.instanceLabel})...`,
    () =>
      withApiContext(
        op.apiFn(deps, ctx.appId, ctx.instanceId, configPayload, {
          destructive: options.destructive,
        }),
        "Failed to push config",
      ),
  );
  deps.log.data(JSON.stringify(result, null, 2));
  deps.log.info("Config pushed successfully");
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
 *
 * `useColor` controls ANSI styling. Defaults to true so existing tests
 * (which strip ANSI codes) keep working when called directly.
 */
export function printDiff(
  deps: Need<{ log: "info" }>,
  current: Record<string, unknown>,
  payload: Record<string, unknown>,
  patchMode: boolean,
  useColor: boolean = true,
): void {
  const keys = topLevelKeys(current, payload, patchMode);

  for (const key of keys) {
    const changes: Change[] = [];
    collectChanges(current[key], payload[key], "", changes, patchMode);
    if (changes.length === 0) continue;

    deps.log.info(`  ${key}:`);
    for (const { path, oldVal, newVal } of changes) {
      if (path) {
        deps.log.info(`    ${path}:`);
      }
      const indent = path ? "      " : "    ";
      if (oldVal !== undefined) {
        const line = `${indent}- ${JSON.stringify(oldVal)}`;
        deps.log.info(useColor ? dim(red(line)) : line);
      }
      if (newVal !== undefined) {
        const line = `${indent}+ ${JSON.stringify(newVal)}`;
        deps.log.info(useColor ? bold(green(line)) : line);
      }
    }
  }
}
