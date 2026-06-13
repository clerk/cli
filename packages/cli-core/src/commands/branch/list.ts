import { resolveAppContext } from "../../lib/config.ts";
import { fetchApplication } from "../../lib/plapi.ts";
import { isAgent } from "../../mode.ts";
import { withApiContext } from "../../lib/errors.ts";
import { log } from "../../lib/log.ts";

interface BranchListOptions {
  app?: string;
}

export async function branchList(options: BranchListOptions): Promise<void> {
  const ctx = await resolveAppContext({ app: options.app });
  const app = await withApiContext(fetchApplication(ctx.appId), "Failed to list branches");
  const branches = app.instances
    .filter((i) => i.branch_name)
    .map((i) => ({
      branch_name: i.branch_name!,
      instance_id: i.instance_id,
      parent_instance_id: i.parent_instance_id,
    }));

  if (isAgent()) {
    log.data(JSON.stringify({ branches }, null, 2));
    return;
  }
  if (branches.length === 0) {
    log.info("No branches.");
    return;
  }
  for (const b of branches) log.data(`${b.branch_name}\t${b.instance_id}`);
}
