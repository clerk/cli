import { resolveAppContext, getActiveInstanceForApp } from "../../lib/config.ts";
import { fetchApplication, deleteInstance } from "../../lib/plapi.ts";
import { isAgent, isHuman } from "../../mode.ts";
import { printJson, type AppsOptions } from "../apps/shared.ts";
import {
  CliError,
  ERROR_CODE,
  UserAbortError,
  isPromptExitError,
  throwUsageError,
  throwUserAbort,
  withApiContext,
} from "../../lib/errors.ts";
import { confirm } from "../../lib/prompts.ts";
import { intro, outro, pausedOutro, withSpinner } from "../../lib/spinner.ts";

interface BranchDeleteOptions extends AppsOptions {
  app?: string;
  name: string;
  yes?: boolean;
  cwd?: string;
}

/**
 * Delete a named branch after enforcing confirmation and active-instance guards.
 */
export async function branchDelete(options: BranchDeleteOptions): Promise<void> {
  // Deleting a branch permanently removes its instance, so require an explicit
  // confirmation. Agents cannot be prompted, so they must pass --yes.
  if (isAgent() && !options.yes) {
    throwUsageError(
      "Pass --yes to delete a branch in agent mode.",
      undefined,
      ERROR_CODE.CONFIRMATION_REQUIRED,
    );
  }

  const shouldWrap = !options.json && !isAgent();
  if (shouldWrap) intro(`Deleting branch · ${options.name}`);
  let closeStatus: "success" | "failed" | "paused" | undefined;

  try {
    const ctx = await resolveAppContext({ app: options.app, cwd: options.cwd });
    const app = await withApiContext(fetchApplication(ctx.appId), "Failed to resolve branch");
    const match = app.instances.find((i) => i.branch_name === options.name);
    if (!match) {
      throw new CliError(`No branch named "${options.name}".`, {
        code: ERROR_CODE.INSTANCE_NOT_FOUND,
      });
    }
    const active = await getActiveInstanceForApp(options.cwd ?? process.cwd(), ctx.appId);
    if (active && active.instanceId === match.instance_id) {
      throwUsageError(
        `\`${options.name}\` is the active instance for this worktree. ` +
          "Switch away first: `clerk switch dev`, then delete.",
        undefined,
        ERROR_CODE.ACTIVE_INSTANCE,
      );
    }
    if (isHuman() && !options.yes) {
      const ok = await confirm({
        message:
          `Permanently delete \`${options.name}\` and its instance? ` +
          "Users and settings on it are lost.",
        default: false,
      });
      if (!ok) {
        throwUserAbort();
      }
    }
    await withSpinner(
      `Deleting ${options.name}...`,
      () => withApiContext(deleteInstance(ctx.appId, match.instance_id), "Failed to delete branch"),
      `Deleted ${options.name} (${match.instance_id})`,
    );
    printJson(
      { status: "deleted", branch_name: options.name, instance_id: match.instance_id },
      options,
    );
    closeStatus = "success";
  } catch (error) {
    closeStatus = error instanceof UserAbortError || isPromptExitError(error) ? "paused" : "failed";
    throw error;
  } finally {
    if (shouldWrap) {
      if (closeStatus === "paused") {
        pausedOutro();
      } else if (closeStatus === "failed") {
        outro("Failed");
      } else if (closeStatus === "success") {
        outro();
      }
    }
  }
}
