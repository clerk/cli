import type { Command, OptionValues } from "@commander-js/extra-typings";
import {
  resolveProfile,
  resolveActiveKey,
  getActiveInstanceForApp,
  setActiveInstance,
} from "../../lib/config.ts";
import { fetchApplication, createBranch, type ApplicationInstance } from "../../lib/plapi.ts";
import { getGitCurrentBranch } from "../../lib/git.ts";
import { pull } from "../env/pull.ts";
import { instanceLabel, resolveSwitchTarget, pickInstance } from "./shared.ts";
import { printJson, type AppsOptions } from "../apps/shared.ts";
import { confirm } from "../../lib/prompts.ts";
import { isAgent } from "../../mode.ts";
import {
  CliError,
  ERROR_CODE,
  UserAbortError,
  isPromptExitError,
  throwUsageError,
  throwUserAbort,
  withApiContext,
} from "../../lib/errors.ts";
import { intro, outro, pausedOutro, withSpinner } from "../../lib/spinner.ts";
import { dim, green } from "../../lib/color.ts";
import { log } from "../../lib/log.ts";

/**
 * Options shared by the top-level switch alias and branch switch command.
 */
export interface BranchSwitchOptions extends AppsOptions {
  app?: string;
  create?: string;
  pull?: boolean;
  detach?: boolean;
  yes?: boolean;
  cwd?: string;
}

async function resolveAppId(
  options: BranchSwitchOptions,
): Promise<{ appId: string; appName?: string }> {
  if (options.app) return { appId: options.app };
  const resolved = await resolveProfile(options.cwd ?? process.cwd());
  if (!resolved) {
    throw new CliError(
      "No Clerk project linked to this directory.\n" +
        "  - Run `clerk link` from your project directory, or\n" +
        "  - Pass --app <app_id> to target an app directly",
      { code: ERROR_CODE.NOT_LINKED },
    );
  }
  return { appId: resolved.profile.appId, appName: resolved.profile.appName };
}

/**
 * Resolve, optionally create, and activate an instance for the current worktree.
 */
export async function branchSwitch(
  targetArg: string | undefined,
  options: BranchSwitchOptions,
): Promise<void> {
  const cwd = options.cwd ?? process.cwd();
  const { appId, appName } = await resolveAppId(options);
  const activeKey = await resolveActiveKey(cwd);
  const current = await getActiveInstanceForApp(cwd, appId);

  const shouldWrap = !options.json && !isAgent();
  if (shouldWrap) intro(`Switching · ${appName ?? appId}`);
  let closeStatus: "success" | "failed" | "paused" | undefined;
  let successOutro = "";

  try {
    const app = await withApiContext(fetchApplication(appId), "Failed to resolve instances");

    let target: ApplicationInstance;
    let parentLabel: string | undefined;

    if (options.create) {
      const parent = resolveSwitchTarget(app, "development");
      parentLabel = instanceLabel(parent);
      const created = await withSpinner(
        `Forking ${parentLabel} → ${options.create}...`,
        () =>
          withApiContext(
            createBranch(appId, {
              cloneInstanceId: parent.instance_id,
              branchName: options.create!,
            }),
            "Failed to create branch",
          ),
        `Forked ${parentLabel} → ${options.create}`,
      );
      const refreshed = await withApiContext(
        fetchApplication(appId),
        "Failed to resolve new branch",
      );
      const match = refreshed.instances.find((i) => i.instance_id === created.id);
      target = match ?? {
        instance_id: created.id,
        environment_type: "development",
        publishable_key: created.publishable_key,
        branch_name: created.branch_name,
        parent_instance_id: parent.instance_id,
      };
    } else if (targetArg === "-") {
      if (!current?.previousInstanceId) {
        throwUsageError(
          "No previous instance to toggle back to. Run `clerk switch <target>` first.",
        );
      }
      const prev = app.instances.find((i) => i.instance_id === current.previousInstanceId);
      if (!prev) {
        throw new CliError("Previous instance no longer exists.", {
          code: ERROR_CODE.INSTANCE_NOT_FOUND,
        });
      }
      target = prev;
    } else if (targetArg) {
      target = resolveSwitchTarget(app, targetArg);
    } else {
      if (isAgent()) {
        // Query mode: mirror the "switched" shape so agents reuse one parser.
        const matched = current
          ? app.instances.find((i) => i.instance_id === current.instanceId)
          : undefined;
        printJson(
          {
            status: "current",
            instance_id: current?.instanceId ?? null,
            branch_name: matched?.branch_name ?? null,
            environment_type: matched?.environment_type ?? current?.environmentType ?? null,
            persisted: Boolean(current),
            exists: current ? Boolean(matched) : null,
          },
          { json: true },
        );
        return;
      }
      target = await pickInstance(app, "Switch to", current?.instanceId);
    }

    const label = instanceLabel(target);
    const isProd = target.environment_type === "production";

    if (isProd && !options.yes) {
      if (isAgent()) {
        throwUsageError(
          "Pass --yes to target production in agent mode.",
          undefined,
          ERROR_CODE.CONFIRMATION_REQUIRED,
        );
      }
      const ok = await confirm({
        message: "Target PRODUCTION? Commands will act on live data until you switch away.",
        default: false,
      });
      if (!ok) throwUserAbort();
    }

    if (!options.detach) {
      const gitBranch = await getGitCurrentBranch(cwd);
      await setActiveInstance(activeKey, {
        appId,
        instanceId: target.instance_id,
        label,
        environmentType: isProd ? "production" : "development",
        ...(target.branch_name ? { branch_name: target.branch_name } : {}),
        previousInstanceId: current?.instanceId,
        previousLabel: current?.label,
        ...(gitBranch ? { gitBranch } : {}),
      });
    }

    const shouldPull = options.pull !== false && !isProd;
    if (shouldPull) {
      await pull({
        app: options.app,
        instance: target.instance_id,
        label,
        embed: shouldWrap,
        cwd,
      });
    }

    if (
      printJson(
        {
          status: "switched",
          instance_id: target.instance_id,
          branch_name: target.branch_name ?? null,
          environment_type: target.environment_type,
          persisted: !options.detach,
          env_pulled: shouldPull,
        },
        options,
      )
    ) {
      return;
    }

    if (isProd && options.pull !== false) {
      log.info(".env.local untouched. Run `clerk env pull --instance prod` if you need prod keys.");
    } else if (!shouldPull && !options.detach) {
      log.info("Skipped .env sync (--no-pull). Run `clerk env pull` to sync keys.");
    }

    const wasDifferent = current && current.instanceId !== target.instance_id;
    let suffix = "";
    if (options.create && parentLabel) {
      suffix = dim(` (branch of ${parentLabel})`);
    } else if (wasDifferent) {
      suffix = dim(` (was ${current.label})`);
    }
    if (options.detach) suffix += dim(" (detached, not saved)");
    successOutro = `${green("●")} ${label} is now active${suffix}`;
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
        outro(successOutro);
      }
    }
  }
}

/**
 * Apply the shared argument + option surface for the `switch` command to a
 * Commander command. Both `clerk switch` (top-level alias) and `clerk branch
 * switch` call this so their flags cannot drift; each registrant adds its own
 * `.description()`, `.setExamples()`, and `.action()`.
 */
export function applySwitchOptions<
  Args extends unknown[],
  Opts extends OptionValues,
  Globals extends OptionValues,
>(command: Command<Args, Opts, Globals>) {
  return command
    .argument("[target]", "dev | prod | <branch-name> | <instance-id> | - (previous)")
    .option(
      "-c, --create <name>",
      "Fork the development instance into a new branch and switch to it",
    )
    .option("--app <id>", "Application ID to target (works from any directory)")
    .option("--no-pull", "Do not sync .env after switching")
    .option("--detach", "Target without saving the active pointer (one-shot)")
    .option("--yes", "Confirm switching into production (required in agent mode)")
    .option("--json", "Output as JSON");
}
