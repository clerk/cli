import { confirm } from "@inquirer/prompts";
import { resolveProfile, resolveInstanceId } from "../../lib/config.ts";
import { putInstanceConfig, patchInstanceConfig } from "../../lib/plapi.ts";
import { isHuman } from "../../mode.ts";
import { CliError, usageError, userAbort, withApiContext } from "../../lib/errors.ts";

interface ConfigPushOptions {
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
  const resolved = await resolveProfile(process.cwd());
  if (!resolved) {
    throw new CliError("No Clerk project linked to this directory. Run `clerk link` to set up.");
  }

  const { profile } = resolved;
  const instance = resolveInstanceId(profile, options.instance);
  const rawInput = await readInput(options);

  let configPayload: Record<string, unknown>;
  try {
    configPayload = JSON.parse(rawInput);
  } catch {
    usageError("Invalid JSON input. Please provide valid JSON.");
  }

  if (typeof configPayload !== "object" || configPayload === null || Array.isArray(configPayload)) {
    usageError("Config must be a JSON object.");
  }

  if (options.dryRun) {
    console.error(`[dry-run] Would ${op.method} config on ${instance.label} instance:`);
    console.log(JSON.stringify(configPayload, null, 2));
    return;
  }

  if (isHuman() && !options.yes) {
    console.error(`\n${op.verb} config on ${instance.label} instance:`);
    console.error(JSON.stringify(configPayload, null, 2));
    if (op.warning) {
      console.error(`\nWARNING: ${op.warning}`);
    }
    const ok = await confirm({ message: "Proceed?" });
    if (!ok) {
      userAbort();
    }
  }

  console.error(`${op.verb} config on ${instance.label} instance...`);

  const result = await withApiContext(
    op.apiFn(profile.appId, instance.id, configPayload),
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
      usageError(`File not found: ${options.file}`);
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
      usageError("No input received from stdin.");
    }
    return text;
  }

  usageError(
    "No input provided. Use --file <path>, --json <string>, or pipe JSON to stdin.\n" +
      "  Example: clerk config patch --file config.json\n" +
      '  Example: clerk config patch --json \'{"session":{"lifetime":3600}}\'\n' +
      "  Example: cat config.json | clerk config patch",
  );
}
