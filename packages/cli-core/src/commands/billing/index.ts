import { resolveAppContext } from "../../lib/config.ts";
import { throwUsageError } from "../../lib/errors.ts";
import { isAgent, isHuman } from "../../mode.ts";
import { log } from "../../lib/log.ts";
import { confirm } from "../../lib/prompts.ts";
import { detectPackageManager } from "../../lib/package-manager.ts";
import { NEXT_STEPS } from "../../lib/next-steps.ts";
import { withGutter } from "../../lib/spinner.ts";
import { applyConfigPatch } from "../config/apply-patch.ts";
import { resolveSkillsRunner, runSkillsAdd } from "../skill/install.ts";

interface BillingOptions {
  app?: string;
  instance?: string;
  for?: string[];
  yes?: boolean;
  dryRun?: boolean;
  skills?: boolean;
}

type Target = "orgs" | "users";

// `org`/`user` are accepted as aliases for backward compatibility with the
// initial release that used singular tokens.
const TARGET_ALIASES: Record<string, Target> = {
  org: "orgs",
  orgs: "orgs",
  user: "users",
  users: "users",
};

// Accepts variadic (`--for orgs users`), CSV (`--for orgs,users`), or repeated
// (`--for orgs --for users`) — mirrors `--keys` on `clerk config pull`.
function parseForTargets(values: string[] | undefined): Target[] {
  if (!values?.length) return ["orgs", "users"];
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

export async function billingEnable(options: BillingOptions): Promise<void> {
  const targets = parseForTargets(options.for);
  const ctx = await resolveAppContext(options);

  const billing: Record<string, unknown> = {};
  const payload: Record<string, unknown> = { billing };
  if (targets.includes("orgs")) {
    billing.organization_enabled = true;
    // Org billing requires orgs enabled; cascade is idempotent.
    payload.organization_settings = { enabled: true };
  }
  if (targets.includes("users")) {
    billing.user_enabled = true;
  }

  await withGutter("Enabling billing", async ({ setNextSteps }) => {
    const applied = await applyConfigPatch({
      ctx,
      payload,
      verb: `Enabling billing for ${describeTargets(targets)}`,
      successMessage: `Billing enabled for ${describeTargets(targets)}`,
      failureContext: "Failed to enable billing",
      yes: options.yes,
      dryRun: options.dryRun,
    });

    if (!applied || options.dryRun) return;

    // `clerk init` doesn't bundle clerk-billing — it's opt-in. Surface it here.
    if (options.skills !== false) await offerBillingSkillInstall(options);
    setNextSteps(NEXT_STEPS.ENABLE_BILLING);
  });
}

async function offerBillingSkillInstall(options: BillingOptions): Promise<void> {
  const skipPrompt = options.yes === true || isAgent();

  if (isHuman() && !skipPrompt) {
    const ok = await confirm({
      message: "Install the `clerk-billing` agent skill? (gives AI agents Clerk billing context)",
      default: true,
    });
    if (!ok) return;
  }

  const interactive = isHuman() && !skipPrompt;
  const cwd = process.cwd();
  const runner = await resolveSkillsRunner(await detectPackageManager(cwd), interactive);
  if (!runner) return;

  const installed = await runSkillsAdd(
    runner,
    cwd,
    "clerk/skills",
    ["clerk-billing"],
    interactive,
    false,
    "clerk-billing",
  );
  if (installed) {
    log.blank();
    log.success("`clerk-billing` agent skill installed.");
  }
}

export async function billingDisable(options: BillingOptions): Promise<void> {
  const targets = parseForTargets(options.for);
  const ctx = await resolveAppContext(options);

  // No cascade: leave organization_settings untouched.
  const billing: Record<string, unknown> = {};
  if (targets.includes("orgs")) billing.organization_enabled = false;
  if (targets.includes("users")) billing.user_enabled = false;

  await withGutter("Disabling billing", async () => {
    await applyConfigPatch({
      ctx,
      payload: { billing },
      verb: `Disabling billing for ${describeTargets(targets)}`,
      successMessage: `Billing disabled for ${describeTargets(targets)}`,
      failureContext: "Failed to disable billing",
      yes: options.yes,
      dryRun: options.dryRun,
    });
  });
}
