import { resolveProfile, getActiveInstanceForApp } from "../../lib/config.ts";
import { getGitCurrentBranch } from "../../lib/git.ts";
import { fetchApplication, type Application } from "../../lib/plapi.ts";
import { printJson, type AppsOptions } from "../apps/shared.ts";
import { CliError, ERROR_CODE, errorMessage } from "../../lib/errors.ts";
import { withSpinner } from "../../lib/spinner.ts";
import { dim, green, red } from "../../lib/color.ts";
import { isAgent } from "../../mode.ts";
import { log } from "../../lib/log.ts";

interface StatusOptions extends AppsOptions {
  cwd?: string;
}

/**
 * Report the active instance, application, and git binding for the current worktree.
 */
export async function status(options: StatusOptions): Promise<void> {
  const cwd = options.cwd ?? process.cwd();
  const resolved = await resolveProfile(cwd);
  if (!resolved) {
    throw new CliError(
      "No Clerk project linked to this directory. Run `clerk link` or pass --app.",
      { code: ERROR_CODE.NOT_LINKED },
    );
  }

  const { profile } = resolved;
  // Ignore a stale cross-app pointer: `clerk link` re-linking a worktree to a
  // different app does not clear the active pointer, so honor it only when it
  // belongs to the resolved app (matches resolveAppContext's guard in
  // lib/config.ts). Otherwise fall back to the development default below.
  const active = await getActiveInstanceForApp(cwd, profile.appId);
  const gitBranch = await getGitCurrentBranch(cwd);

  const activeLabel = active?.label ?? "development";
  const activeInstanceId = active?.instanceId ?? profile.instances.development;
  const drift =
    active?.gitBranch && gitBranch && active.gitBranch !== gitBranch ? active.gitBranch : undefined;

  // Validate the pointer against the live instance list. Offline or failed
  // fetches degrade to the local view (exists stays null) instead of failing
  // the whole command, since status is also the tool people reach for when
  // the network is the problem.
  let app: Application | undefined;
  try {
    const fetchApp = () => fetchApplication(profile.appId);
    app =
      !options.json && !isAgent()
        ? await withSpinner("Checking instance...", fetchApp)
        : await fetchApp();
  } catch (error) {
    log.debug(`status: instance check skipped: ${errorMessage(error)}`);
  }
  const matched = app?.instances.find((i) => i.instance_id === activeInstanceId);
  const exists = app ? Boolean(matched) : null;

  if (
    printJson(
      {
        app_id: profile.appId,
        app_name: profile.appName ?? null,
        active: {
          instance_id: activeInstanceId,
          label: activeLabel,
          environment_type: active?.environmentType ?? "development",
          exists,
        },
        git_branch: gitBranch ?? null,
        git_drift: drift ?? null,
      },
      options,
    )
  ) {
    return;
  }

  // Annotate the active instance with what the label alone doesn't carry:
  // trunks are marked (trunk), branches name their fork parent.
  let annotation = "";
  if (matched) {
    if (matched.branch_name) {
      const parent = app?.instances.find((i) => i.instance_id === matched.parent_instance_id);
      const parentLabel = parent ? (parent.branch_name ?? parent.environment_type) : "development";
      annotation = ` ${dim(`(branch of ${parentLabel})`)}`;
    } else {
      annotation = ` ${dim("(trunk)")}`;
    }
  }

  log.info(`App:      ${profile.appName ?? profile.appId} (${profile.appId})`);
  if (exists === false) {
    log.info(`Active:   ${red(`${activeLabel} · instance no longer exists`)}  ${activeInstanceId}`);
    log.warn(
      "The active instance was deleted. Run `clerk switch` to pick a new one; " +
        ".env.local still holds its stale keys until you do.",
    );
  } else {
    log.info(`Active:   ${green("●")} ${activeLabel}${annotation}  ${dim(activeInstanceId ?? "")}`);
  }
  log.info(`Git:      ${gitBranch ? `on branch \`${gitBranch}\`` : "not on a git branch"}`);
  if (drift) {
    log.warn(
      `\`${activeLabel}\` was selected while on git branch \`${drift}\`; you are now on ` +
        `\`${gitBranch}\`. If that is not intentional, run \`clerk switch\` to re-point.`,
    );
  }
}
