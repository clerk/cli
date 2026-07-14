import type { Application, ApplicationInstance } from "../../lib/plapi.ts";
import { AutocompletePrompt, isCancel } from "@clack/core";
import { CliError, ERROR_CODE, throwUsageError, throwUserAbort } from "../../lib/errors.ts";
import { INSTANCE_ALIASES, instanceLabel, isPrimaryInstance } from "../../lib/config.ts";
import { select, ttyContext } from "../../lib/listage.ts";
import { formatRelativeTime } from "../../lib/time.ts";
import { bold, cyan, dim, green } from "../../lib/color.ts";

// The env-qualified glyph label lives in lib/config.ts so lib-layer resolvers can
// share it; re-export it here for the branch command surface (ADR-0007).
export { instanceLabel };

/**
 * Resolve a switch target string (dev|prod|<branch-name>|<instance-id>) to an
 * instance on the application. Throws a CliError if nothing matches. `dev` and
 * `main` both land on the development root (two lenses, one instance).
 */
export function resolveSwitchTarget(app: Application, target: string): ApplicationInstance {
  const alias = INSTANCE_ALIASES[target];
  if (alias) {
    const match = app.instances.find((i) => i.environment_type === alias && isPrimaryInstance(i));
    if (match) return match;
    throw new CliError(`No ${alias} instance found for this application.`, {
      code: ERROR_CODE.INSTANCE_NOT_FOUND,
    });
  }

  const byBranch = app.instances.find((i) => i.branch_name === target);
  if (byBranch) return byBranch;

  const byId = app.instances.find((i) => i.instance_id === target);
  if (byId) return byId;

  const names = app.instances.map(instanceLabel).join(", ");
  throw new CliError(`No instance "${target}". Available: ${names}`, {
    code: ERROR_CODE.INSTANCE_NOT_FOUND,
  });
}

/**
 * Title-case an environment type for display.
 */
export function titleCaseEnvironment(environmentType: string): string {
  return environmentType.charAt(0).toUpperCase() + environmentType.slice(1);
}

/**
 * Passive branching gate (ADR-0015): the branch/switch commands never enable
 * anything, they only refuse to fork with a hint when branching isn't ready.
 * Reads the serialized application-level state; an available-but-not-enabled app
 * points at `clerk enable branches`, an unavailable app just reports so. Unset
 * (older payloads) is treated as not-available (fail-closed, ADR-0013).
 */
export function assertBranchingEnabled(app: Application): void {
  if (app.branches_enabled) return;
  if (app.branches_available) {
    throwUsageError(
      "Development branches aren't enabled. " +
        "Run `clerk enable branches` or enable it in the dashboard.",
    );
  }
  throwUsageError("Development branches aren't available for this instance.");
}

// ---------------------------------------------------------------------------
// Branch-name validation. Mirrors clerk_go's ValidateBranchName +
// IsReservedBranchName (the authoritative backend gate) and the dashboard's
// getBranchNameError. Enforced client-side so both `clerk branch create` and
// `clerk switch --create` reject invalid names before the API round-trip.
// ---------------------------------------------------------------------------

// Longest branch name accepted by the branch service. Git-ref rules do the real
// work; this only blocks absurd input.
const MAX_BRANCH_NAME_LENGTH = 255;

// A single git ref path segment: ASCII letters, digits, and the ref-safe
// punctuation '.', '_', '-'. The allowlist already excludes every byte git
// forbids anywhere in a refname (control chars, space, and ~ ^ : ? * [ \).
const VALID_BRANCH_SEGMENT = /^[A-Za-z0-9._-]+$/;

// Names rejected by the backend because they collide with the two-lens
// vocabulary. Mirrors clerk_go's reservedBranchNames (matched
// case-insensitively). Kept in sync with the dashboard's reserved list.
const RESERVED_BRANCH_NAMES = new Set(["main", "dev", "prod", "development", "production"]);

/**
 * Validate a branch name against git check-ref-format (allowlist form) and the
 * reserved-name policy. Returns a user-facing message, or null when valid.
 */
export function branchNameError(name: string): string | null {
  if (!name) {
    return "Branch name is required.";
  }
  if (name.trim() !== name) {
    return "Branch name cannot start or end with a space.";
  }
  if (name.length > MAX_BRANCH_NAME_LENGTH) {
    return `Branch name must be ${MAX_BRANCH_NAME_LENGTH} characters or fewer.`;
  }
  if (name.includes("..")) {
    return "Branch name cannot contain '..'.";
  }
  if (name.startsWith("/") || name.endsWith("/") || name.includes("//")) {
    return "Branch name cannot have a leading, trailing, or empty path segment.";
  }
  for (const segment of name.split("/")) {
    if (!VALID_BRANCH_SEGMENT.test(segment)) {
      return "Branch name can only contain letters, numbers, and the characters . _ - / (no spaces).";
    }
    if (segment.startsWith(".") || segment.endsWith(".")) {
      return "Branch name segments cannot start or end with '.'.";
    }
    if (segment.endsWith(".lock")) {
      return "Branch name segments cannot end with '.lock'.";
    }
  }
  if (RESERVED_BRANCH_NAMES.has(name.toLowerCase())) {
    return "Branch name is reserved. Choose a name other than main, dev, prod, development, or production.";
  }
  return null;
}

/**
 * Throw a usage error when name is not a valid, non-reserved branch name. Used
 * for flag values (`--name`, `switch --create`) in every mode; the interactive
 * prompt calls branchNameError directly so it can re-ask instead of throwing.
 */
export function assertValidBranchName(name: string): void {
  const error = branchNameError(name);
  if (error) {
    throwUsageError(error, undefined, ERROR_CODE.USAGE_ERROR);
  }
}

// ---------------------------------------------------------------------------
// Shared branch-tree model: `main` (the null-parent branch) pinned at the top
// with its forks nested beneath as a box-drawing tree. Production has no branch
// identity and never appears (ADR-0005). Both `clerk branch list` and the
// `clerk switch` branch stage render this same tree.
// ---------------------------------------------------------------------------

const COLUMN_PADDING = 2;
/**
 * Width of a branch's box-drawing tree prefix.
 */
export const BRANCH_TREE_PREFIX_WIDTH = 3;

/**
 * A projected row in the shared branch tree.
 */
export type BranchTableRow =
  | { kind: "main"; instance: ApplicationInstance }
  | { kind: "fork"; instance: ApplicationInstance; isLast: boolean };

/**
 * Shared row projection and column widths for branch list and switch rendering.
 */
export interface BranchTable {
  rows: BranchTableRow[];
  nameWidth: number;
  idWidth: number;
}

/**
 * Split an application's branch instances into the pinned `main` root (the
 * branch whose `parent_instance_id` is null) and its forks. Instances without a
 * branch name (production, and a non-enabled app's nameless dev root) are
 * excluded, so this is a pure branch view.
 */
export function developmentBranches(app: Application): {
  main: ApplicationInstance | undefined;
  forks: ApplicationInstance[];
} {
  const branches = app.instances.filter((i) => i.branch_name);
  return {
    main: branches.find((i) => isPrimaryInstance(i)),
    forks: branches.filter((i) => !isPrimaryInstance(i)),
  };
}

/**
 * Return a relative age label for a creation timestamp, or an empty string.
 */
export function createdLabel(createdAt: number | undefined, now: number): string {
  return createdAt ? formatRelativeTime(createdAt, now) : "";
}

/**
 * Return the box-drawing prefix for a fork row.
 */
export function branchTreePrefix(isLast: boolean): string {
  return ` ${isLast ? "└ " : "├ "}`;
}

/**
 * Render padded branch, instance ID, and creation-date header cells.
 */
export function branchHeaderCells(nameWidth: number, idWidth: number): string {
  return `${"BRANCH".padEnd(nameWidth)}${"INSTANCE ID".padEnd(idWidth)}CREATED`;
}

/**
 * Project an application's branches into the shared tree: `main` first (no tree
 * prefix), then its forks as a flat box-drawing tree. Column widths are computed
 * once over every row so both renderers align identically.
 */
export function buildBranchTable(app: Application): BranchTable {
  const { main, forks } = developmentBranches(app);

  const rows: BranchTableRow[] = [];
  if (main) rows.push({ kind: "main", instance: main });
  forks.forEach((instance, index) =>
    rows.push({ kind: "fork", instance, isLast: index === forks.length - 1 }),
  );

  const nameWidth =
    Math.max(
      "BRANCH".length,
      ...(main ? [main.branch_name!.length] : []),
      ...forks.map((f) => BRANCH_TREE_PREFIX_WIDTH + f.branch_name!.length),
    ) + COLUMN_PADDING;
  const idWidth =
    Math.max("INSTANCE ID".length, ...rows.map((r) => r.instance.instance_id.length)) +
    COLUMN_PADDING;

  return { rows, nameWidth, idWidth };
}

// ---------------------------------------------------------------------------
// Interactive two-stage switch selector (ADR-0006): stage 1 picks the
// environment, stage 2 picks the branch. Any single-option stage is skipped.
// ---------------------------------------------------------------------------

/**
 * A branch row rendered by the interactive branch-stage picker.
 */
export interface InstancePickerOption {
  value: string;
  label: string;
  created: string | undefined;
  instance: ApplicationInstance;
  tree: string;
}

/**
 * Build branch-stage picker rows from the shared tree: `main` first (no tree
 * prefix), then its forks with box-drawing connectors.
 */
export function buildInstancePickerOptions(app: Application, now: number): InstancePickerOption[] {
  const { rows } = buildBranchTable(app);
  return rows.map((row) => ({
    value: row.instance.instance_id,
    // The branch stage runs after the environment is chosen, so rows read as bare
    // branch names (main, feature-auth) rather than the env-qualified glyph.
    label: row.instance.branch_name ?? row.instance.environment_type,
    created: createdLabel(row.instance.created_at, now) || undefined,
    instance: row.instance,
    tree: row.kind === "fork" ? branchTreePrefix(row.isLast) : "",
  }));
}

/**
 * Stage 1: pick the environment. Development is offered when a development root
 * or any branch exists; Production when a production root exists. A single
 * option resolves without prompting (ADR-0006).
 */
async function pickEnvironment(
  hasDevelopment: boolean,
  prodRoot: ApplicationInstance | undefined,
  currentInstanceId: string | undefined,
): Promise<"development" | "production"> {
  const options: Array<{ value: "development" | "production"; name: string }> = [];
  if (hasDevelopment) options.push({ value: "development", name: "Development" });
  if (prodRoot) options.push({ value: "production", name: "Production" });

  if (options.length === 0) {
    throw new CliError("No instances found for this application.", {
      code: ERROR_CODE.INSTANCE_NOT_FOUND,
    });
  }
  if (options.length === 1) return options[0]!.value;

  const current =
    prodRoot && currentInstanceId === prodRoot.instance_id ? "production" : "development";
  return select<"development" | "production">({
    message: "Select an environment:",
    choices: options,
    default: current,
  });
}

/**
 * Stage 2: pick a branch from the shared tree (`main` + forks) with clack's
 * highlight/selection state layered on top. The active instance is tagged
 * `(current)` and preselected so the cursor opens on it.
 */
async function pickBranch(
  app: Application,
  message: string,
  currentInstanceId: string | undefined,
  now: number,
): Promise<ApplicationInstance> {
  const options = buildInstancePickerOptions(app, now);
  const initialValue = options.some((option) => option.value === currentInstanceId)
    ? [currentInstanceId!]
    : undefined;
  const tty = ttyContext();
  const prompt = new AutocompletePrompt<InstancePickerOption>({
    options,
    initialValue,
    input: tty?.input,
    filter: (term, option) => {
      const needle = term.toLowerCase();
      return [option.label, option.value].some((value) => value.toLowerCase().includes(needle));
    },
    render() {
      if (this.state === "submit") return `${cyan("◆")}  ${message}\n${dim("└")}  Selected`;
      if (this.state === "cancel") return `${cyan("◆")}  ${message}\n${dim("└")}  Cancelled`;
      const lines = [
        `${cyan("◆")}  ${message}`,
        dim("│"),
        `${dim("│")}  ${dim("Search:")} ${this.userInputWithCursor}`,
      ];
      const searching = this.userInput.length > 0;
      for (const [index, option] of this.filteredOptions.entries()) {
        const state =
          index === this.cursor
            ? "cursor"
            : option.value === currentInstanceId
              ? "current"
              : "normal";
        const marker = state === "cursor" ? bold(green("●")) : dim(state === "current" ? "◉" : "○");
        const label = searching ? option.label : `${option.tree}${option.label}`;
        const body = state === "cursor" ? label : dim(label);
        const age = option.created
          ? state === "cursor"
            ? option.created.replace(/ ago$/, " old")
            : dim(option.created.replace(/ ago$/, " old"))
          : "";
        lines.push(`${dim("│")}  ${marker} ${body}  ${dim(option.value)}${age ? `  ${age}` : ""}`);
      }
      lines.push(
        `${dim("│")}  ${dim("↑/↓")} to select • ${dim("Enter:")} confirm • ${dim("Type:")} to search`,
        dim("└"),
      );
      return lines.join("\n");
    },
  });
  try {
    const instanceId = await prompt.prompt();
    if (isCancel(instanceId) || instanceId === undefined) throwUserAbort();
    const chosen = app.instances.find((i) => i.instance_id === instanceId);
    if (!chosen) {
      throw new CliError(`Instance ${String(instanceId)} not found.`, {
        code: ERROR_CODE.INSTANCE_NOT_FOUND,
      });
    }
    return chosen;
  } finally {
    tty?.close();
  }
}

/**
 * Two-stage interactive selector following the two lenses (ADR-0006): stage 1
 * picks the environment (Development / Production), stage 2 picks the branch
 * (`main` + forks). Every single-option stage is skipped: no production skips
 * stage 1, and a lone `main` skips stage 2. Production never reaches stage 2.
 * Human-only; callers gate on isHuman(). `now` is injectable for deterministic
 * tests and defaults to the current time.
 */
export async function pickInstance(
  app: Application,
  message: string,
  currentInstanceId?: string,
  now: number = Date.now(),
): Promise<ApplicationInstance> {
  const devRoot = app.instances.find(
    (i) => i.environment_type === "development" && isPrimaryInstance(i),
  );
  const prodRoot = app.instances.find(
    (i) => i.environment_type === "production" && isPrimaryInstance(i),
  );
  const { main, forks } = developmentBranches(app);

  const environment = await pickEnvironment(
    Boolean(devRoot || main || forks.length > 0),
    prodRoot,
    currentInstanceId,
  );
  if (environment === "production") return prodRoot!;

  // Development chosen. The branch root is `main` when named, else the nameless
  // dev root. A lone root (no forks) resolves immediately, skipping stage 2.
  const branchRoot = main ?? devRoot;
  if (!branchRoot) {
    throw new CliError("No development instance found for this application.", {
      code: ERROR_CODE.INSTANCE_NOT_FOUND,
    });
  }
  if (forks.length === 0) return branchRoot;
  return pickBranch(app, message, currentInstanceId, now);
}
