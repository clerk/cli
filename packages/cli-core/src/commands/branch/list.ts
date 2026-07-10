import { resolveAppContext, getActiveInstanceForApp, isPrimaryInstance } from "../../lib/config.ts";
import { fetchApplication, type Application } from "../../lib/plapi.ts";
import { UserAbortError, isPromptExitError, withApiContext } from "../../lib/errors.ts";
import { dim, cyan } from "../../lib/color.ts";
import { withSpinner, intro, outro, pausedOutro } from "../../lib/spinner.ts";
import { ui } from "../../lib/ui.ts";
import {
  titleCaseEnvironment,
  buildBranchTable,
  branchHeaderCells,
  branchTreePrefix,
  createdLabel,
  BRANCH_TREE_PREFIX_WIDTH,
  ENVIRONMENT_ORDER,
} from "./shared.ts";
import { printJson, type AppsOptions } from "../apps/shared.ts";
import { isAgent } from "../../mode.ts";

interface BranchListOptions extends AppsOptions {
  app?: string;
  cwd?: string;
}

// Leading marker column: "● " on the active instance, "  " otherwise (git-style).
const MARKER_WIDTH = 2;

/**
 * Render branches on stderr (via `ui`) under one shared column header. Every
 * trunk (the `Development` / `Production` root instances) is always listed as a
 * header row: its title-cased name in plain white, the root's instance id, and
 * a `-` in place of a created date: even when it has no branches. Branches
 * always fork the development root, so they follow the Development row as one
 * flat box-drawing tree (` ├ ` / ` └ `) reading as forks of it, the same tree
 * shape as the `clerk switch` picker. An empty Development row gets a dim
 * `No branches` placeholder so its header never stands bare; Production is
 * always a selectable root but never carries forks, so it stands alone.
 * Grouping replaces the old PARENT column. The active instance is marked with
 * `●`. Machine consumers use `--json` (the active instance is
 * `active_instance_id`).
 */
function formatBranchesTable(app: Application, activeId: string | undefined, now: number): void {
  const { rows, nameWidth, idWidth } = buildBranchTable(app);

  const header = `${"".padEnd(MARKER_WIDTH)}${branchHeaderCells(nameWidth, idWidth)}`;
  const markerFor = (instanceId?: string): string => (instanceId === activeId ? "● " : "  ");

  const lines = [dim(header)];
  for (const row of rows) {
    if (row.kind === "trunk") {
      // Trunk header: title-cased environment name in plain white, root id, and
      // a dash where a created date would be.
      const name = titleCaseEnvironment(row.env).padEnd(nameWidth);
      const id = dim((row.instance?.instance_id ?? "").padEnd(idWidth));
      lines.push(`${markerFor(row.instance?.instance_id)}${name}${id}${dim("-")}`);
    } else if (row.kind === "placeholder") {
      // A trunk with no forks gets a dim, non-selectable placeholder aligned
      // under where branch names would sit, so the header never stands bare.
      lines.push(
        `${"".padEnd(MARKER_WIDTH)}${" ".repeat(BRANCH_TREE_PREFIX_WIDTH)}${dim("No branches")}`,
      );
    } else {
      const b = row.instance;
      const prefix = branchTreePrefix(row.isLast);
      const label = `${prefix}${b.branch_name!}`;
      const branchName = `${dim(prefix)}${cyan(b.branch_name!)}${" ".repeat(Math.max(0, nameWidth - label.length))}`;
      const branchId = dim(b.instance_id.padEnd(idWidth));
      const created = dim(createdLabel(b.created_at, now));
      lines.push(`${markerFor(b.instance_id)}${branchName}${branchId}${created}`);
    }
  }

  ui.message(lines);
}

/**
 * List an application's root instances and branches in human or JSON form.
 */
export async function branchList(options: BranchListOptions = {}): Promise<void> {
  const shouldWrap = !options.json && !isAgent();
  if (shouldWrap) intro("Listing branches");
  let closeStatus: "success" | "failed" | "paused" | undefined;

  try {
    const ctx = await resolveAppContext({ app: options.app, cwd: options.cwd });
    const fetchApp = () => withApiContext(fetchApplication(ctx.appId), "Failed to list branches");
    const app = shouldWrap ? await withSpinner("Fetching branches...", fetchApp) : await fetchApp();

    const environmentRank = (env: string): number => {
      const index = ENVIRONMENT_ORDER.indexOf(env);
      return index === -1 ? ENVIRONMENT_ORDER.length : index;
    };

    // Two flat arrays: the trunk (dev/prod root) instances and the branches,
    // each linked to its parent via parent_instance_id (always the development
    // root, since branches only fork development). Trunks are development-first.
    const trunks = app.instances
      .filter(isPrimaryInstance)
      .sort((a, b) => environmentRank(a.environment_type) - environmentRank(b.environment_type))
      .map((t) => ({
        environment_type: t.environment_type,
        instance_id: t.instance_id,
        publishable_key: t.publishable_key,
        created_at: t.created_at ?? null,
      }));

    const branches = app.instances
      .filter((i) => i.branch_name)
      .map((i) => ({
        branch_name: i.branch_name!,
        instance_id: i.instance_id,
        parent_instance_id: i.parent_instance_id,
        publishable_key: i.publishable_key,
        created_at: i.created_at,
      }));

    const active = await getActiveInstanceForApp(options.cwd ?? process.cwd(), app.application_id);
    const activeId = active?.instanceId;
    // The pointer can outlive its instance (deleted from another checkout);
    // surface that instead of silently dropping the marker.
    const activeMissing = Boolean(
      activeId && !app.instances.some((i) => i.instance_id === activeId),
    );

    if (
      printJson(
        {
          trunks,
          branches,
          active_instance_id: activeId ?? null,
          active_instance_missing: activeMissing,
        },
        options,
      )
    ) {
      return;
    }

    // Always render the table so the dev/prod trunk rows are shown even when no
    // branches exist yet.
    formatBranchesTable(app, activeId, Date.now());
    ui.message(
      branches.length === 0
        ? "No branches yet."
        : `${branches.length} branch${branches.length === 1 ? "" : "es"}`,
    );
    if (activeMissing) {
      ui.warn(
        `Active instance \`${active!.label}\` (${activeId}) is not in this app anymore. ` +
          "Run `clerk switch` to re-point this worktree.",
      );
    }
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
