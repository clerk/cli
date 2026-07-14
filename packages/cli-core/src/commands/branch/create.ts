import { resolveAppContext, isPrimaryInstance } from "../../lib/config.ts";
import { createBranch, fetchApplication } from "../../lib/plapi.ts";
import { assertBranchingEnabled } from "./shared.ts";
import { branchSwitch } from "./switch.ts";
import { printJson, type AppsOptions } from "../apps/shared.ts";
import { withApiContext } from "../../lib/errors.ts";
import { withSpinner } from "../../lib/spinner.ts";
import { isHuman } from "../../mode.ts";
import { log } from "../../lib/log.ts";

interface BranchCreateOptions extends AppsOptions {
  app?: string;
  name: string;
  switch?: boolean;
}

/**
 * Create a branch by forking the application's development root instance.
 */
export async function branchCreate(options: BranchCreateOptions): Promise<void> {
  const ctx = await resolveAppContext({ app: options.app, instance: "development" });
  const app = await withApiContext(fetchApplication(ctx.appId), "Failed to resolve application");
  // Passive gate (ADR-0015): never enable; refuse to fork with a hint when
  // branching isn't ready.
  assertBranchingEnabled(app);

  // Fork messages use the bare parent branch name (`Forking main → …`); the dev
  // root is named `main` once branching is enabled (ADR-0007/0017).
  const devRoot = app.instances.find(
    (i) => i.environment_type === "development" && isPrimaryInstance(i),
  );
  const parentLabel = devRoot?.branch_name ?? "development";
  const branch = await withSpinner(`Forking ${parentLabel} → ${options.name}...`, () =>
    withApiContext(
      createBranch(ctx.appId, { cloneInstanceId: ctx.instanceId, branchName: options.name }),
      "Failed to create branch",
    ),
  );

  // -s/--switch: activate the new branch for this worktree. Delegate to the
  // switch command so the pointer update, .env sync, and output stay identical
  // to `clerk switch <branch>` (and `clerk switch -c`). In agent mode branchSwitch
  // emits the lone "switched" JSON object; the human line below is suppressed.
  if (options.switch) {
    if (isHuman()) log.success(`Forked \`${parentLabel}\` → \`${options.name}\` (${branch.id})`);
    await branchSwitch(options.name, { app: options.app, json: options.json });
    return;
  }

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
  log.success(`Forked \`${parentLabel}\` → \`${options.name}\` (${branch.id})`);
}
