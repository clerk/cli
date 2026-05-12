import { resolveAppContext } from "../../lib/config.ts";
import { throwUsageError } from "../../lib/errors.ts";
import { NEXT_STEPS, printNextSteps } from "../../lib/next-steps.ts";
import { applyConfigPatch } from "../config/apply-patch.ts";

interface APIKeysOptions {
  app?: string;
  instance?: string;
  for?: string[];
  yes?: boolean;
  dryRun?: boolean;
}

type Target = "orgs" | "users";

const TARGET_ALIASES: Record<string, Target> = {
  org: "orgs",
  orgs: "orgs",
  user: "users",
  users: "users",
};

function parseForTargets(values: string[] | undefined, defaultTargets?: Target[]): Target[] {
  if (!values?.length) return defaultTargets ?? [];
  const seen = new Set<Target>();
  for (const value of values) {
    for (const part of value.split(",")) {
      const trimmed = part.trim();
      if (!trimmed) continue;
      const canonical = TARGET_ALIASES[trimmed];
      if (!canonical) {
        throwUsageError(`Invalid --for value: "${trimmed}". Expected "orgs" and/or "users".`);
      }
      seen.add(canonical);
    }
  }
  if (seen.size === 0) {
    throwUsageError('--for must include at least one of: "orgs", "users".');
  }
  return [...seen];
}

function describeTargets(targets: Target[]): string {
  const parts = targets.map((t) => (t === "orgs" ? "organizations" : "users"));
  return parts.length === 2 ? `${parts[0]} and ${parts[1]}` : parts[0]!;
}

export async function apiKeysEnable(options: APIKeysOptions): Promise<void> {
  const targets = parseForTargets(options.for, ["users"]);
  const ctx = await resolveAppContext(options);

  const apiKeysSettings: Record<string, unknown> = { enabled: true };
  const payload: Record<string, unknown> = { api_keys_settings: apiKeysSettings };
  if (targets.includes("users")) apiKeysSettings.user_api_keys_enabled = true;
  if (targets.includes("orgs")) {
    apiKeysSettings.orgs_api_keys_enabled = true;
    // Org API Keys require organizations; cascade is idempotent.
    payload.organization_settings = { enabled: true };
  }

  const applied = await applyConfigPatch({
    ctx,
    payload,
    verb: `Enabling API Keys for ${describeTargets(targets)}`,
    successMessage: `API Keys enabled for ${describeTargets(targets)}`,
    failureContext: "Failed to enable API Keys",
    yes: options.yes,
    dryRun: options.dryRun,
  });

  if (applied && !options.dryRun) printNextSteps(NEXT_STEPS.ENABLE_API_KEYS);
}

export async function apiKeysDisable(options: APIKeysOptions): Promise<void> {
  const targets = parseForTargets(options.for);
  const ctx = await resolveAppContext(options);

  const apiKeysSettings: Record<string, unknown> = {};
  let verb = "Disabling API Keys";
  let successMessage = "API Keys disabled";
  if (targets.length === 0) {
    apiKeysSettings.enabled = false;
    apiKeysSettings.user_api_keys_enabled = false;
    apiKeysSettings.orgs_api_keys_enabled = false;
  } else {
    if (targets.includes("users")) apiKeysSettings.user_api_keys_enabled = false;
    if (targets.includes("orgs")) apiKeysSettings.orgs_api_keys_enabled = false;
    verb = `Disabling API Keys for ${describeTargets(targets)}`;
    successMessage = `API Keys disabled for ${describeTargets(targets)}`;
  }

  await applyConfigPatch({
    ctx,
    payload: { api_keys_settings: apiKeysSettings },
    verb,
    successMessage,
    failureContext: "Failed to disable API Keys",
    yes: options.yes,
    dryRun: options.dryRun,
  });
}
