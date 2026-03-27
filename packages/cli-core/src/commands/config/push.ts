import { resolveAppContext } from "../../lib/config.ts";
import { fetchInstanceConfig, putInstanceConfig, patchInstanceConfig } from "../../lib/plapi.ts";
import { isHuman } from "../../mode.ts";
import { throwUsageError, throwUserAbort, withApiContext, ERROR_CODE } from "../../lib/errors.ts";
import { confirm } from "../../lib/prompts.ts";
import { dim, bold } from "../../lib/color.ts";

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
    options?: { destructive?: boolean },
  ) => Promise<Record<string, unknown>>;
};

const PUT_OP: Operation = {
  method: "PUT",
  verb: "Replacing",
  warning: "This will overwrite the entire instance configuration.",
  apiFn: putInstanceConfig,
};

const PATCH_OP: Operation = {
  method: "PATCH",
  verb: "Updating",
  apiFn: patchInstanceConfig,
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

  if (options.dryRun) {
    console.error(`[dry-run] Would ${op.method} config on ${ctx.instanceLabel} instance:`);
    console.log(JSON.stringify(configPayload, null, 2));
    return;
  }

  const currentConfig = await withApiContext(
    fetchInstanceConfig(ctx.appId, ctx.instanceId),
    "Failed to fetch current config",
  );

  const isPatch = op.method === "PATCH";
  const hasChanges = hasConfigChanges(currentConfig, configPayload, isPatch);

  if (!hasChanges) {
    console.error("No changes detected.");
    return;
  }

  if (isHuman() && !options.yes) {
    console.error(`\n${op.verb} config on ${ctx.instanceLabel} instance:\n`);
    printDiff(currentConfig, configPayload, isPatch);

    if (op.warning) {
      console.error(`\nWARNING: ${op.warning}`);
    }
    const ok = await confirm({ message: "Proceed?" });
    if (!ok) {
      throwUserAbort();
    }
  }

  console.error(`${op.verb} config on ${ctx.instanceLabel} instance...`);

  const result = await withApiContext(
    op.apiFn(ctx.appId, ctx.instanceId, configPayload, { destructive: options.destructive }),
    "Failed to push config",
  );
  console.log(JSON.stringify(result, null, 2));
  console.error("Config pushed successfully.");
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
      throwUsageError("No input received from stdin.");
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

/**
 * Returns true if the payload would change any config values.
 * In patch mode only keys in the payload are compared;
 * in put mode all keys from both sides are compared.
 */
export function hasConfigChanges(
  current: Record<string, unknown>,
  payload: Record<string, unknown>,
  patchMode: boolean,
): boolean {
  const keys = patchMode
    ? Object.keys(payload)
    : [...new Set([...Object.keys(current), ...Object.keys(payload)])];
  for (const key of keys) {
    if (JSON.stringify(current[key]) !== JSON.stringify(payload[key])) return true;
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
  type Change = { path: string; oldVal?: unknown; newVal?: unknown };

  function collectChanges(oldObj: unknown, newObj: unknown, path: string, out: Change[]): void {
    if (JSON.stringify(oldObj) === JSON.stringify(newObj)) return;

    const bothObjects =
      oldObj != null &&
      newObj != null &&
      typeof oldObj === "object" &&
      typeof newObj === "object" &&
      !Array.isArray(oldObj) &&
      !Array.isArray(newObj);

    if (bothObjects) {
      // In patch mode, only walk keys from the new object (the patch payload).
      // In put mode, walk both sides so deletions are visible.
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
        );
      }
      return;
    }

    out.push({ path, oldVal: oldObj, newVal: newObj });
  }

  // In put mode, walk all keys from both sides so removed top-level keys show up.
  const topLevelKeys = patchMode
    ? Object.keys(payload)
    : [...new Set([...Object.keys(current), ...Object.keys(payload)])];

  for (const key of topLevelKeys) {
    const changes: Change[] = [];
    collectChanges(current[key], payload[key], "", changes);
    if (changes.length === 0) continue;

    console.error(`  ${key}:`);
    for (const { path, oldVal, newVal } of changes) {
      if (path) {
        console.error(`    ${path}:`);
      }
      const indent = path ? "      " : "    ";
      if (oldVal !== undefined) {
        console.error(dim(`${indent}- ${JSON.stringify(oldVal)}`));
      }
      if (newVal !== undefined) {
        console.error(bold(`${indent}+ ${JSON.stringify(newVal)}`));
      }
    }
  }
}
