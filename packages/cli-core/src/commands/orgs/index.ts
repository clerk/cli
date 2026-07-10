import { resolveAppContext } from "../../lib/config.ts";
import { fetchInstanceConfig } from "../../lib/plapi.ts";
import { throwUsageError, withApiContext } from "../../lib/errors.ts";
import { withGutter, withSpinner, formatTargetSuffix } from "../../lib/spinner.ts";
import { isHuman } from "../../mode.ts";
import { NEXT_STEPS } from "../../lib/next-steps.ts";
import { applyConfigPatch } from "../config/apply-patch.ts";

interface OrgsOptions {
  app?: string;
  instance?: string;
  branch?: string;
  forceSelection?: boolean;
  autoCreate?: boolean;
  maxMembers?: string;
  domains?: boolean;
  yes?: boolean;
  dryRun?: boolean;
}

function parsePositiveInt(value: string, flag: string): number {
  // Reject anything that isn't a sequence of digits — `parseInt("12abc", 10)`
  // would silently truncate and ship corrupt data to the API.
  if (!/^\d+$/.test(value)) {
    throwUsageError(`${flag} must be a positive integer (got "${value}").`);
  }
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < 1) {
    throwUsageError(`${flag} must be a positive integer (got "${value}").`);
  }
  return n;
}

export async function orgsEnable(options: OrgsOptions): Promise<void> {
  const ctx = await resolveAppContext(options);

  const orgSettings: Record<string, unknown> = { enabled: true };
  if (options.forceSelection) orgSettings.force_organization_selection = true;
  if (options.domains) orgSettings.domains_enabled = true;
  if (options.autoCreate) {
    orgSettings.organization_creation_defaults = {
      automatic_organization_creation: { enabled: true },
    };
  }
  if (options.maxMembers !== undefined) {
    orgSettings.max_allowed_memberships = parsePositiveInt(options.maxMembers, "--max-members");
  }

  await withGutter(
    `Enabling organizations${formatTargetSuffix(ctx.instanceLabel)}`,
    async ({ setNextSteps }) => {
      const applied = await applyConfigPatch({
        ctx,
        payload: { organization_settings: orgSettings },
        verb: "Enabling organizations",
        successMessage: "Organizations enabled",
        failureContext: "Failed to enable organizations",
        yes: options.yes,
        dryRun: options.dryRun,
      });

      if (applied && !options.dryRun) {
        setNextSteps(NEXT_STEPS.ENABLE_ORGS);
      }
    },
  );
}

export async function orgsDisable(options: OrgsOptions): Promise<void> {
  const ctx = await resolveAppContext(options);

  await withGutter(`Disabling organizations${formatTargetSuffix(ctx.instanceLabel)}`, async () => {
    const current = await withSpinner("Fetching current config...", () =>
      withApiContext(
        fetchInstanceConfig(ctx.appId, ctx.instanceId, ["billing", "organization_settings"]),
        "Failed to fetch config",
      ),
    );

    const billing = current.billing as Record<string, unknown> | undefined;
    const orgBillingOn = billing?.organization_enabled === true;

    // Agent mode: refuse rather than warn-then-mutate (warn-then-mutate in CI
    // logs reads as "the warning was heeded" when it wasn't).
    if (orgBillingOn && !isHuman() && !options.yes) {
      throwUsageError(
        "Organization billing is enabled. Disabling organizations would leave `billing.organization_enabled` stranded. " +
          "Run `clerk disable billing --for orgs` first, or pass --yes to override.",
      );
    }

    await applyConfigPatch({
      ctx,
      payload: { organization_settings: { enabled: false } },
      verb: "Disabling organizations",
      successMessage: "Organizations disabled",
      failureContext: "Failed to disable organizations",
      yes: options.yes,
      dryRun: options.dryRun,
      warning: orgBillingOn
        ? "Organization billing is currently enabled. Disabling organizations will leave `billing.organization_enabled` stranded — consider running `clerk disable billing --for orgs` separately."
        : undefined,
      currentConfig: current,
    });
  });
}
