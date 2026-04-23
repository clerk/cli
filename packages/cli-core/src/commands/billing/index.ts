import { resolveAppContext } from "../../lib/config.ts";
import { fetchInstanceConfig, patchInstanceConfig } from "../../lib/plapi.ts";
import { throwUsageError, withApiContext } from "../../lib/errors.ts";
import { withSpinner } from "../../lib/spinner.ts";
import { log } from "../../lib/log.ts";
import { cyan, dim } from "../../lib/color.ts";

interface BillingOptions {
  app?: string;
  instance?: string;
  for?: string;
  requirePaymentMethod?: boolean;
  yes?: boolean;
}

function validateFor(value: string | undefined): "org" | "user" {
  if (!value) {
    throwUsageError("--for is required. Use --for org or --for user.");
  }
  if (value !== "org" && value !== "user") {
    throwUsageError(`Invalid --for value: "${value}". Must be "org" or "user".`);
  }
  return value;
}

export async function billingEnable(options: BillingOptions): Promise<void> {
  const target = validateFor(options.for);
  const ctx = await resolveAppContext(options);

  const patch: Record<string, unknown> = {};
  if (target === "org") {
    patch.organization_enabled = true;
  } else {
    patch.user_enabled = true;
  }
  if (options.requirePaymentMethod !== undefined) {
    patch.free_trial_requires_payment_method = options.requirePaymentMethod;
  }

  const config = { billing: patch };

  const result = await withSpinner(
    `Enabling ${target} billing on ${ctx.appLabel} (${ctx.instanceLabel})...`,
    () =>
      withApiContext(
        patchInstanceConfig(ctx.appId, ctx.instanceId, config),
        "Failed to enable billing",
      ),
  );

  log.data(JSON.stringify(result, null, 2));
  log.success(`Billing enabled for ${target === "org" ? "organizations" : "users"}`);
}

export async function billingDisable(options: BillingOptions): Promise<void> {
  const target = validateFor(options.for);
  const ctx = await resolveAppContext(options);

  const patch: Record<string, unknown> = {};
  if (target === "org") {
    patch.organization_enabled = false;
  } else {
    patch.user_enabled = false;
  }

  const config = { billing: patch };

  const result = await withSpinner(
    `Disabling ${target} billing on ${ctx.appLabel} (${ctx.instanceLabel})...`,
    () =>
      withApiContext(
        patchInstanceConfig(ctx.appId, ctx.instanceId, config),
        "Failed to disable billing",
      ),
  );

  log.data(JSON.stringify(result, null, 2));
  log.success(`Billing disabled for ${target === "org" ? "organizations" : "users"}`);
}

// --- Plans subcommand ---

interface PlansCreateOptions {
  app?: string;
  instance?: string;
  name?: string;
  amount: string;
  currency?: string;
  payer?: string;
  description?: string;
  trialDays?: string;
  hidden?: boolean;
  annualAmount?: string;
  yes?: boolean;
}

function titleCase(slug: string): string {
  return slug
    .split(/[-_]/)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

export async function plansCreate(slug: string, options: PlansCreateOptions): Promise<void> {
  const ctx = await resolveAppContext(options);

  const plan: Record<string, unknown> = {
    name: options.name || titleCase(slug),
    amount: parseInt(options.amount, 10),
    payer_type: options.payer,
    is_recurring: true,
    publicly_visible: !options.hidden,
  };

  if (options.currency) plan.currency = options.currency;
  if (options.description) plan.description = options.description;
  if (options.annualAmount) plan.annual_monthly_amount = parseInt(options.annualAmount, 10);
  if (options.trialDays) {
    plan.free_trial_enabled = true;
    plan.free_trial_days = parseInt(options.trialDays, 10);
  }

  const config = { billing: { plans: { [slug]: plan } } };

  const result = await withSpinner(
    `Creating plan ${cyan(options.name || titleCase(slug))} on ${ctx.appLabel} (${ctx.instanceLabel})...`,
    () =>
      withApiContext(
        patchInstanceConfig(ctx.appId, ctx.instanceId, config),
        "Failed to create plan",
      ),
  );

  log.data(JSON.stringify(result, null, 2));
  log.success(`Plan ${cyan(options.name || titleCase(slug))} ${dim(`(${slug})`)} created`);
}

interface PlansListOptions {
  app?: string;
  instance?: string;
  json?: boolean;
}

export async function plansList(options: PlansListOptions): Promise<void> {
  const ctx = await resolveAppContext(options);

  const current = await withSpinner("Fetching billing config...", () =>
    withApiContext(
      fetchInstanceConfig(ctx.appId, ctx.instanceId, ["billing"]),
      "Failed to fetch config",
    ),
  );

  const billing = current.billing as Record<string, unknown> | undefined;
  const plans = (billing?.plans as Record<string, Record<string, unknown>>) ?? {};

  if (options.json) {
    log.data(JSON.stringify(plans, null, 2));
    return;
  }

  const entries = Object.entries(plans);
  if (entries.length === 0) {
    log.info("No plans configured. Use `clerk billing plans create` to add one.");
    return;
  }

  for (const [slug, plan] of entries) {
    const amount = plan.amount as number;
    const currency = (plan.currency as string) || "usd";
    const price = amount === 0 ? "Free" : `${(amount / 100).toFixed(2)} ${currency.toUpperCase()}`;
    const payer = plan.payer_type as string;
    const visible = plan.publicly_visible !== false;
    const trial = plan.free_trial_enabled ? ` (${plan.free_trial_days}d trial)` : "";

    log.info(
      `${cyan(plan.name as string)} ${dim(`(${slug})`)} — ${price}/mo — ${payer}${trial}${!visible ? dim(" [hidden]") : ""}`,
    );
  }
}

interface PlansUpdateOptions {
  app?: string;
  instance?: string;
  name?: string;
  amount?: string;
  currency?: string;
  description?: string;
  trialDays?: string;
  hidden?: boolean;
  visible?: boolean;
  annualAmount?: string;
  yes?: boolean;
}

export async function plansUpdate(slug: string, options: PlansUpdateOptions): Promise<void> {
  const ctx = await resolveAppContext(options);

  const plan: Record<string, unknown> = {};
  if (options.name) plan.name = options.name;
  if (options.amount) plan.amount = parseInt(options.amount, 10);
  if (options.currency) plan.currency = options.currency;
  if (options.description) plan.description = options.description;
  if (options.annualAmount) plan.annual_monthly_amount = parseInt(options.annualAmount, 10);
  if (options.hidden) plan.publicly_visible = false;
  if (options.visible) plan.publicly_visible = true;
  if (options.trialDays) {
    plan.free_trial_enabled = true;
    plan.free_trial_days = parseInt(options.trialDays, 10);
  }

  if (Object.keys(plan).length === 0) {
    throwUsageError("No update options provided. Use --name, --amount, --hidden, etc.");
  }

  const config = { billing: { plans: { [slug]: plan } } };

  const result = await withSpinner(
    `Updating plan ${cyan(slug)} on ${ctx.appLabel} (${ctx.instanceLabel})...`,
    () =>
      withApiContext(
        patchInstanceConfig(ctx.appId, ctx.instanceId, config),
        "Failed to update plan",
      ),
  );

  log.data(JSON.stringify(result, null, 2));
  log.success(`Plan ${cyan(slug)} updated`);
}

interface PlansRemoveOptions {
  app?: string;
  instance?: string;
  yes?: boolean;
}

export async function plansRemove(slug: string, options: PlansRemoveOptions): Promise<void> {
  const ctx = await resolveAppContext(options);

  // Fetch current config so we can PUT without the plan
  const current = await withSpinner("Fetching current config...", () =>
    withApiContext(
      fetchInstanceConfig(ctx.appId, ctx.instanceId, ["billing"]),
      "Failed to fetch config",
    ),
  );

  const billing = current.billing as Record<string, unknown> | undefined;
  const plans = { ...((billing?.plans as Record<string, unknown>) ?? {}) };

  if (!(slug in plans)) {
    throwUsageError(`Plan "${slug}" not found.`);
  }

  delete plans[slug];

  const config = { billing: { plans } };

  const result = await withSpinner(
    `Removing plan ${cyan(slug)} on ${ctx.appLabel} (${ctx.instanceLabel})...`,
    () =>
      withApiContext(
        patchInstanceConfig(ctx.appId, ctx.instanceId, config, { destructive: true }),
        "Failed to remove plan",
      ),
  );

  log.data(JSON.stringify(result, null, 2));
  log.success(`Plan ${cyan(slug)} removed`);
}
