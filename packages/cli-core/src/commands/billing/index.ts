import { resolveAppContext } from "../../lib/config.ts";
import { throwUsageError } from "../../lib/errors.ts";
import { applyConfigPatch } from "../config/apply-patch.ts";

interface BillingOptions {
  app?: string;
  instance?: string;
  for?: string[];
  yes?: boolean;
  dryRun?: boolean;
}

type Target = "org" | "user";

/**
 * Parse the `--for` option, which accepts both variadic and comma-separated
 * forms (mirroring `--keys` on `clerk config pull`):
 *
 *   --for org user      → ["org", "user"]
 *   --for org,user      → ["org", "user"]
 *   --for org --for user → ["org", "user"]
 *   (omitted)           → ["org", "user"] (default to both)
 */
function parseForTargets(values: string[] | undefined): Target[] {
  if (!values?.length) return ["org", "user"];
  const seen = new Set<Target>();
  for (const value of values) {
    for (const part of value.split(",")) {
      const trimmed = part.trim();
      if (!trimmed) continue;
      if (trimmed !== "org" && trimmed !== "user") {
        throwUsageError(`Invalid --for value: "${trimmed}". Expected "org" and/or "user".`);
      }
      seen.add(trimmed);
    }
  }
  if (seen.size === 0) {
    throwUsageError('--for must include at least one of: "org", "user".');
  }
  return [...seen];
}

function describeTargets(targets: Target[]): string {
  const parts = targets.map((t) => (t === "org" ? "organizations" : "users"));
  return parts.length === 2 ? `${parts[0]} and ${parts[1]}` : parts[0]!;
}

export async function billingEnable(options: BillingOptions): Promise<void> {
  const targets = parseForTargets(options.for);
  const ctx = await resolveAppContext(options);

  const billing: Record<string, unknown> = {};
  const payload: Record<string, unknown> = { billing };
  if (targets.includes("org")) {
    billing.organization_enabled = true;
    // Cascade-enable orgs whenever billing is being turned on for orgs. This
    // is idempotent — if orgs are already enabled the diff stays empty.
    payload.organization_settings = { enabled: true };
  }
  if (targets.includes("user")) {
    billing.user_enabled = true;
  }

  await applyConfigPatch({
    ctx,
    payload,
    verb: `Enabling billing for ${describeTargets(targets)}`,
    successMessage: `Billing enabled for ${describeTargets(targets)}`,
    failureContext: "Failed to enable billing",
    yes: options.yes,
    dryRun: options.dryRun,
  });
}

export async function billingDisable(options: BillingOptions): Promise<void> {
  const targets = parseForTargets(options.for);
  const ctx = await resolveAppContext(options);

  // Disabling billing never cascades to disabling organizations — leave
  // `organization_settings` untouched per spec.
  const billing: Record<string, unknown> = {};
  if (targets.includes("org")) billing.organization_enabled = false;
  if (targets.includes("user")) billing.user_enabled = false;

  await applyConfigPatch({
    ctx,
    payload: { billing },
    verb: `Disabling billing for ${describeTargets(targets)}`,
    successMessage: `Billing disabled for ${describeTargets(targets)}`,
    failureContext: "Failed to disable billing",
    yes: options.yes,
    dryRun: options.dryRun,
  });
}
