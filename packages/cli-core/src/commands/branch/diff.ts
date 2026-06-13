import { resolveAppContext } from "../../lib/config.ts";
import { fetchInstanceConfig } from "../../lib/plapi.ts";
import { printDiff } from "../config/push.ts";
import { withApiContext } from "../../lib/errors.ts";
import { withSpinner } from "../../lib/spinner.ts";

interface BranchDiffOptions {
  app?: string;
  name: string;
  against?: string;
}

export async function branchDiff(options: BranchDiffOptions): Promise<void> {
  const branchCtx = await resolveAppContext({ app: options.app, branch: options.name });
  const parentCtx = await resolveAppContext({
    app: options.app,
    instance: options.against ?? "production",
  });
  const [parentConfig, branchConfig] = await withSpinner(
    `Diffing ${options.name} against ${parentCtx.instanceLabel}...`,
    () =>
      Promise.all([
        withApiContext(
          fetchInstanceConfig(parentCtx.appId, parentCtx.instanceId),
          "Failed to fetch parent config",
        ),
        withApiContext(
          fetchInstanceConfig(branchCtx.appId, branchCtx.instanceId),
          "Failed to fetch branch config",
        ),
      ]),
  );
  delete (parentConfig as Record<string, unknown>).config_version;
  delete (branchConfig as Record<string, unknown>).config_version;
  printDiff(parentConfig, branchConfig, false);
}
