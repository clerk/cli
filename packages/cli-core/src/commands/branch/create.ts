import { resolveAppContext, isPrimaryInstance } from "../../lib/config.ts";
import { createBranch, fetchApplication } from "../../lib/plapi.ts";
import { assertBranchingEnabled } from "./shared.ts";
import { branchSwitch } from "./switch.ts";
import { printJson, type AppsOptions } from "../apps/shared.ts";
import { ERROR_CODE, throwUsageError, withApiContext } from "../../lib/errors.ts";
import { confirm, text } from "../../lib/prompts.ts";
import { withSpinner } from "../../lib/spinner.ts";
import { isAgent, isHuman } from "../../mode.ts";
import { log } from "../../lib/log.ts";

interface BranchCreateOptions extends AppsOptions {
  app?: string;
  name?: string;
  switch?: boolean;
}

/**
 * Create a branch by forking the application's development root instance.
 *
 * With `--name` the command is non-interactive. With no `--name` in human mode
 * it prompts for the branch name and offers to switch the worktree to the new
 * branch. Agent mode cannot be prompted, so it still requires `--name`.
 */
export async function branchCreate(options: BranchCreateOptions): Promise<void> {
  // Captured before we resolve the name so the follow-up switch prompt only
  // appears when the whole command ran interactively.
  const interactive = !options.name && isHuman();

  // Fail fast (no network) when an agent omits the one required input.
  if (!options.name && isAgent()) {
    throwUsageError(
      "Pass --name to create a branch in agent mode.",
      undefined,
      ERROR_CODE.USAGE_ERROR,
    );
  }

  const ctx = await resolveAppContext({ app: options.app, instance: "development" });
  const app = await withApiContext(fetchApplication(ctx.appId), "Failed to resolve application");
  // Passive gate (ADR-0015): never enable; refuse to fork with a hint when
  // branching isn't ready. Checked before prompting so an interactive user is
  // not asked for a name we cannot use.
  assertBranchingEnabled(app);

  const name = options.name ?? (await promptBranchName());

  // Fork messages use the bare parent branch name (`Forking main → …`); the dev
  // root is named `main` once branching is enabled (ADR-0007/0017).
  const devRoot = app.instances.find(
    (i) => i.environment_type === "development" && isPrimaryInstance(i),
  );
  const parentLabel = devRoot?.branch_name ?? "development";
  const branch = await withSpinner(`Forking ${parentLabel} → ${name}...`, () =>
    withApiContext(
      createBranch(ctx.appId, { cloneInstanceId: ctx.instanceId, branchName: name }),
      "Failed to create branch",
    ),
  );

  // Switch when asked explicitly (--switch) or, in the interactive flow, when
  // the user confirms the offer. Delegating to the switch command keeps the
  // pointer update, .env sync, and output identical to `clerk switch <branch>`.
  // In agent mode branchSwitch emits the lone "switched" JSON object; the human
  // line below is suppressed.
  const shouldSwitch =
    options.switch || (interactive && !options.json && (await promptSwitch(name)));

  if (shouldSwitch) {
    if (isHuman()) log.success(`Forked \`${parentLabel}\` → \`${name}\` (${branch.id})`);
    await branchSwitch(name, { app: options.app, json: options.json });
    return;
  }

  if (
    printJson(
      {
        status: "created",
        branch_name: name,
        instance_id: branch.id,
        parent_instance_id: ctx.instanceId,
      },
      options,
    )
  ) {
    return;
  }
  log.success(`Forked \`${parentLabel}\` → \`${name}\` (${branch.id})`);
}

/** Prompt for the branch name, rejecting an empty value. */
function promptBranchName(): Promise<string> {
  return text({
    message: "Branch name",
    placeholder: "agent/pr-42",
    validate: (value) => (value && value.trim().length > 0 ? undefined : "Enter a branch name."),
  });
}

/** Offer to switch the worktree to the freshly created branch. */
function promptSwitch(name: string): Promise<boolean> {
  return confirm({ message: `Switch this worktree to \`${name}\` now?`, default: true });
}
