import { resolveAppContext } from "../../lib/config.ts";
import { fetchApplication, deleteInstance } from "../../lib/plapi.ts";
import { isAgent } from "../../mode.ts";
import { CliError, ERROR_CODE, withApiContext } from "../../lib/errors.ts";
import { withSpinner } from "../../lib/spinner.ts";
import { log } from "../../lib/log.ts";

interface BranchDeleteOptions {
  app?: string;
  name: string;
}

export async function branchDelete(options: BranchDeleteOptions): Promise<void> {
  const ctx = await resolveAppContext({ app: options.app });
  const app = await withApiContext(fetchApplication(ctx.appId), "Failed to resolve branch");
  const match = app.instances.find((i) => i.branch_name === options.name);
  if (!match) {
    throw new CliError(`No branch named "${options.name}".`, {
      code: ERROR_CODE.INSTANCE_NOT_FOUND,
    });
  }
  await withSpinner(`Deleting ${options.name}...`, () =>
    withApiContext(deleteInstance(ctx.appId, match.instance_id), "Failed to delete branch"),
  );
  if (isAgent()) {
    log.data(
      JSON.stringify(
        { status: "deleted", branch_name: options.name, instance_id: match.instance_id },
        null,
        2,
      ),
    );
    return;
  }
  log.success(`Deleted branch \`${options.name}\``);
}
