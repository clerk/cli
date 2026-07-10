import { resolveAppContext } from "../../lib/config.ts";
import { createBranch } from "../../lib/plapi.ts";
import { printJson, type AppsOptions } from "../apps/shared.ts";
import { withApiContext } from "../../lib/errors.ts";
import { withSpinner } from "../../lib/spinner.ts";
import { log } from "../../lib/log.ts";

interface BranchCreateOptions extends AppsOptions {
  app?: string;
  name: string;
}

/**
 * Create a branch by forking the application's development root instance.
 */
export async function branchCreate(options: BranchCreateOptions): Promise<void> {
  const ctx = await resolveAppContext({ app: options.app, instance: "development" });
  const branch = await withSpinner(`Forking ${ctx.instanceLabel} → ${options.name}...`, () =>
    withApiContext(
      createBranch(ctx.appId, { cloneInstanceId: ctx.instanceId, branchName: options.name }),
      "Failed to create branch",
    ),
  );

  if (
    printJson(
      {
        status: "created",
        branch_name: options.name,
        instance_id: branch.id,
        parent_instance_id: ctx.instanceId,
      },
      options,
    )
  ) {
    return;
  }
  log.success(`Forked \`${ctx.instanceLabel}\` → \`${options.name}\` (${branch.id})`);
}
