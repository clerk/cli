import { confirm } from "@inquirer/prompts";
import { resolveAppContext } from "../../lib/config.ts";
import { putInstanceConfig, patchInstanceConfig } from "../../lib/plapi.ts";
import { isHuman } from "../../mode.ts";
import { throwUsageError, throwUserAbort, withApiContext } from "../../lib/errors.ts";

interface ConfigPushOptions {
  app?: string;
  instance?: string;
  file?: string;
  json?: string;
  dryRun?: boolean;
  yes?: boolean;
}

type Operation = {
  method: "PUT" | "PATCH";
  verb: string;
  warning?: string;
  apiFn: (
    appId: string,
    instId: string,
    config: Record<string, unknown>,
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
    throwUsageError("Invalid JSON input. Please provide valid JSON.");
  }

  if (typeof configPayload !== "object" || configPayload === null || Array.isArray(configPayload)) {
    throwUsageError("Config must be a JSON object.");
  }

  if (options.dryRun) {
    console.error(`[dry-run] Would ${op.method} config on ${ctx.instanceLabel} instance:`);
    console.log(JSON.stringify(configPayload, null, 2));
    return;
  }

  if (isHuman() && !options.yes) {
    console.error(`\n${op.verb} config on ${ctx.instanceLabel} instance:`);
    console.error(JSON.stringify(configPayload, null, 2));
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
    op.apiFn(ctx.appId, ctx.instanceId, configPayload),
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
      throwUsageError(`File not found: ${options.file}`);
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
