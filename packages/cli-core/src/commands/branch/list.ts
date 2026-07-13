import { resolveAppContext, getActiveInstanceForApp } from "../../lib/config.ts";
import { fetchApplication, type Application } from "../../lib/plapi.ts";
import { UserAbortError, isPromptExitError, withApiContext } from "../../lib/errors.ts";
import { dim, cyan } from "../../lib/color.ts";
import { withSpinner, intro, outro, pausedOutro } from "../../lib/spinner.ts";
import { ui } from "../../lib/ui.ts";
import {
  buildBranchTable,
  branchHeaderCells,
  branchTreePrefix,
  createdLabel,
  developmentBranches,
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
 * Render the pure branch view on stderr (via `ui`) under one shared column
 * header: `main` is pinned at the top as the default branch (no tree prefix),
 * with its forks nested beneath as a flat box-drawing tree (` ├ ` / ` └ `),
 * reading as forks of it and matching the `clerk switch` picker. Production has
 * no branch identity and never appears. The active instance is marked with `●`.
 * Machine consumers use `--json` (the active instance is `active_instance_id`).
 */
function formatBranchesTable(app: Application, activeId: string | undefined, now: number): void {
  const { rows, nameWidth, idWidth } = buildBranchTable(app);

  const header = `${"".padEnd(MARKER_WIDTH)}${branchHeaderCells(nameWidth, idWidth)}`;
  const markerFor = (instanceId: string): string => (instanceId === activeId ? "● " : "  ");

  const lines = [dim(header)];
  for (const row of rows) {
    const b = row.instance;
    const prefix = row.kind === "fork" ? branchTreePrefix(row.isLast) : "";
    const label = `${prefix}${b.branch_name!}`;
    const branchName = `${dim(prefix)}${cyan(b.branch_name!)}${" ".repeat(Math.max(0, nameWidth - label.length))}`;
    const branchId = dim(b.instance_id.padEnd(idWidth));
    const created = dim(createdLabel(b.created_at, now));
    lines.push(`${markerFor(b.instance_id)}${branchName}${branchId}${created}`);
  }

  ui.message(lines);
}

/**
 * List an application's branches (`main` + forks) in human or JSON form.
 */
export async function branchList(options: BranchListOptions = {}): Promise<void> {
  const shouldWrap = !options.json && !isAgent();
  if (shouldWrap) intro("Listing branches");
  let closeStatus: "success" | "failed" | "paused" | undefined;

  try {
    const ctx = await resolveAppContext({ app: options.app, cwd: options.cwd });
    const fetchApp = () => withApiContext(fetchApplication(ctx.appId), "Failed to list branches");
    const app = shouldWrap ? await withSpinner("Fetching branches...", fetchApp) : await fetchApp();

    // A single branches list (ADR-0005): `main` first (the null-parent branch),
    // then its forks carrying parent_instance_id pointing at main's instance.
    // Production has no branch identity and is excluded; no `default` flag is
    // needed because `main` is identified by its null parent.
    const { main, forks } = developmentBranches(app);
    const ordered = [...(main ? [main] : []), ...forks];
    const branches = ordered.map((i) => ({
      branch_name: i.branch_name!,
      instance_id: i.instance_id,
      parent_instance_id: i.parent_instance_id ?? null,
      publishable_key: i.publishable_key,
      created_at: i.created_at ?? null,
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
          branches,
          active_instance_id: activeId ?? null,
          active_instance_missing: activeMissing,
        },
        options,
      )
    ) {
      return;
    }

    if (ordered.length === 0) {
      ui.message("No branches yet.");
    } else {
      formatBranchesTable(app, activeId, Date.now());
      ui.message(`${ordered.length} branch${ordered.length === 1 ? "" : "es"}`);
    }
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
