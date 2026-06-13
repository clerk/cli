import { resolveAppContext } from "../../lib/config.ts";
import { createBranch } from "../../lib/plapi.ts";
import { isAgent } from "../../mode.ts";
import { withApiContext } from "../../lib/errors.ts";
import { withSpinner } from "../../lib/spinner.ts";
import { log } from "../../lib/log.ts";

interface BranchCreateOptions {
  app?: string;
  name: string;
  from?: string;
}

export async function branchCreate(options: BranchCreateOptions): Promise<void> {
  const ctx = await resolveAppContext({ app: options.app, instance: options.from ?? "production" });
  const branch = await withSpinner(`Forking ${ctx.instanceLabel} → ${options.name}...`, () =>
    withApiContext(
      createBranch(ctx.appId, { cloneInstanceId: ctx.instanceId, branchName: options.name }),
      "Failed to create branch",
    ),
  );

  if (isAgent()) {
    log.data(
      JSON.stringify(
        {
          status: "created",
          branch_name: options.name,
          instance_id: branch.id,
          parent_instance_id: ctx.instanceId,
        },
        null,
        2,
      ),
    );
    return;
  }
  log.success(`Forked \`${ctx.instanceLabel}\` → \`${options.name}\` (${branch.id})`);
}
