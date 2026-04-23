import { resolveAppContext } from "../../lib/config.ts";
import { fetchInstanceConfig, patchInstanceConfig } from "../../lib/plapi.ts";
import { withApiContext } from "../../lib/errors.ts";
import { withSpinner } from "../../lib/spinner.ts";
import { log } from "../../lib/log.ts";

interface OrgsOptions {
  app?: string;
  instance?: string;
  forceSelection?: boolean;
  autoCreate?: boolean;
  maxMembers?: string;
  domains?: boolean;
  yes?: boolean;
}

export async function orgsEnable(options: OrgsOptions): Promise<void> {
  const ctx = await resolveAppContext(options);

  const patch: Record<string, unknown> = { enabled: true };
  if (options.forceSelection) patch.force_organization_selection = true;
  if (options.domains) patch.domains_enabled = true;
  if (options.maxMembers) patch.max_allowed_memberships = parseInt(options.maxMembers, 10);
  if (options.autoCreate) {
    patch.organization_creation_defaults = {
      automatic_organization_creation: { enabled: true },
    };
  }

  const config = { organization_settings: patch };

  const result = await withSpinner(
    `Enabling organizations on ${ctx.appLabel} (${ctx.instanceLabel})...`,
    () =>
      withApiContext(
        patchInstanceConfig(ctx.appId, ctx.instanceId, config),
        "Failed to enable organizations",
      ),
  );

  log.data(JSON.stringify(result, null, 2));
  log.success("Organizations enabled");
}

export async function orgsDisable(options: OrgsOptions): Promise<void> {
  const ctx = await resolveAppContext(options);

  // Check if billing depends on orgs
  const current = await withSpinner("Checking current config...", () =>
    withApiContext(
      fetchInstanceConfig(ctx.appId, ctx.instanceId, ["billing"]),
      "Failed to fetch config",
    ),
  );

  const billing = current.billing as Record<string, unknown> | undefined;
  if (billing?.organization_enabled) {
    log.warn(
      "Organization billing is enabled. Disabling organizations will also disable org billing.",
    );
  }

  const config = { organization_settings: { enabled: false } };

  const result = await withSpinner(
    `Disabling organizations on ${ctx.appLabel} (${ctx.instanceLabel})...`,
    () =>
      withApiContext(
        patchInstanceConfig(ctx.appId, ctx.instanceId, config),
        "Failed to disable organizations",
      ),
  );

  log.data(JSON.stringify(result, null, 2));
  log.success("Organizations disabled");
}
