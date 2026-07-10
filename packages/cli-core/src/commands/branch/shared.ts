import type { Application, ApplicationInstance } from "../../lib/plapi.ts";
import { AutocompletePrompt, isCancel } from "@clack/core";
import { CliError, ERROR_CODE, throwUserAbort } from "../../lib/errors.ts";
import { INSTANCE_ALIASES, isPrimaryInstance } from "../../lib/config.ts";
import { ttyContext } from "../../lib/listage.ts";
import { formatRelativeTime } from "../../lib/time.ts";
import { bold, cyan, dim, green } from "../../lib/color.ts";

/**
 * Display label for an instance using its branch name or environment type.
 */
export function instanceLabel(i: ApplicationInstance): string {
  return i.branch_name || i.environment_type;
}

/**
 * Resolve a switch target string (dev|prod|<branch-name>|<instance-id>) to an
 * instance on the application. Throws a CliError if nothing matches.
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

// ---------------------------------------------------------------------------
// Shared branch-table model: the single grouping + column layout that both
// `clerk branch list` and the `clerk switch` picker render.
// ---------------------------------------------------------------------------

const COLUMN_PADDING = 2;
/**
 * Width of a branch's box-drawing tree prefix.
 */
export const BRANCH_TREE_PREFIX_WIDTH = 3;
/**
 * Preferred top-to-bottom order for primary environments.
 */
export const ENVIRONMENT_ORDER = ["development", "production"];

/**
 * A projected row in the shared branch table.
 */
export type BranchTableRow =
  | { kind: "trunk"; env: string; instance: ApplicationInstance | undefined }
  | { kind: "branch"; instance: ApplicationInstance; isLast: boolean }
  | { kind: "placeholder"; env: string };

/**
 * Shared row projection and column widths for branch list and switch rendering.
 */
export interface BranchTable {
  rows: BranchTableRow[];
  nameWidth: number;
  idWidth: number;
}

/**
 * Return a relative age label for a creation timestamp, or an empty string.
 */
export function createdLabel(createdAt: number | undefined, now: number): string {
  return createdAt ? formatRelativeTime(createdAt, now) : "";
}

/**
 * Return the box-drawing prefix for a branch row.
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
 * Group an application's instances into the shared branch table. Every dev/prod
 * trunk is a header row (listed even with no branches). Branches always fork the
 * development root, so they all group as one flat box-drawing tree under the
 * Development row; only that row gets a `placeholder` when it has no forks.
 * Production is always listed as a selectable root but never carries branches.
 * Column widths are computed once over every row so both renderers align
 * identically.
 */
export function buildBranchTable(app: Application): BranchTable {
  const branches = app.instances.filter((i) => i.branch_name);

  // Branches always fork the development root, so every branch groups under the
  // Development section regardless of the parent id on the record.
  const sections = new Map<string, ApplicationInstance[]>();
  if (branches.length > 0) sections.set("development", branches);

  const trunkByEnvironment = new Map(
    app.instances.filter(isPrimaryInstance).map((t) => [t.environment_type, t]),
  );
  const environments = new Set([...trunkByEnvironment.keys(), ...sections.keys()]);
  const orderedEnvironments = [
    ...ENVIRONMENT_ORDER.filter((e) => environments.has(e)),
    ...[...environments].filter((e) => !ENVIRONMENT_ORDER.includes(e)).sort(),
  ];

  const nameWidth =
    Math.max(
      "BRANCH".length,
      ...branches.map((b) => BRANCH_TREE_PREFIX_WIDTH + b.branch_name!.length),
      ...orderedEnvironments.map((e) => e.length),
    ) + COLUMN_PADDING;
  const idWidth =
    Math.max(
      "INSTANCE ID".length,
      ...branches.map((b) => b.instance_id.length),
      ...orderedEnvironments.map((e) => trunkByEnvironment.get(e)?.instance_id.length ?? 0),
    ) + COLUMN_PADDING;

  const rows: BranchTableRow[] = [];
  for (const env of orderedEnvironments) {
    rows.push({ kind: "trunk", env, instance: trunkByEnvironment.get(env) });
    const sectionBranches = sections.get(env) ?? [];
    if (sectionBranches.length === 0) {
      // Only the Development root can hold forks, so it is the only row that
      // shows a placeholder when empty; Production stands alone.
      if (env === "development") rows.push({ kind: "placeholder", env });
      continue;
    }
    sectionBranches.forEach((b, index) =>
      rows.push({ kind: "branch", instance: b, isLast: index === sectionBranches.length - 1 }),
    );
  }

  return { rows, nameWidth, idWidth };
}

// ---------------------------------------------------------------------------
// Interactive picker: the same table as `clerk branch list`, with clack's
// highlight/selection state layered on top.
// ---------------------------------------------------------------------------

/**
 * A live instance row rendered by the custom interactive picker.
 */
export interface InstancePickerOption {
  value: string;
  label: string;
  created: string | undefined;
  environment: string;
  kind: "primary" | "branch";
  instance: ApplicationInstance | undefined;
  tree: string;
  disabled: boolean;
}

// Sentinel value for the rare non-selectable trunk row (an orphan branch's
// synthetic env header with no primary instance). clack skips disabled
// options and never returns their value, so it never resolves to a real
// instance.
const NON_SELECTABLE_PREFIX = "nonselectable:";

/**
 * Build searchable picker rows from the shared branch-table projection.
 */
export function buildInstancePickerOptions(app: Application, now: number): InstancePickerOption[] {
  const table = buildBranchTable(app);
  let environment = "";
  return table.rows.flatMap<InstancePickerOption>((row) => {
    if (row.kind === "placeholder") return [];
    if (row.kind === "trunk") {
      environment = row.env;
      return [
        {
          value: row.instance?.instance_id ?? `${NON_SELECTABLE_PREFIX}${row.env}`,
          label: titleCaseEnvironment(row.env),
          created: undefined,
          environment: row.env,
          kind: "primary" as const,
          instance: row.instance,
          tree: "",
          disabled: !row.instance,
        },
      ];
    }
    return [
      {
        value: row.instance.instance_id,
        label: `${titleCaseEnvironment(environment)} ⎇ ${row.instance.branch_name!}`,
        created: createdLabel(row.instance.created_at, now) || undefined,
        environment,
        kind: "branch" as const,
        instance: row.instance,
        tree: branchTreePrefix(row.isLast),
        disabled: false,
      },
    ];
  });
}

/**
 * Interactive picker over all instances, rendered as the same table as
 * `clerk branch list`: a pinned dim column header (carried in the prompt
 * message so clack draws no radio in front of it), trunk rows, and a flat
 * box-drawing branch tree (an empty trunk simply has nothing beneath it).
 * clack supplies the highlight/selection state; the active
 * instance is tagged `(current)` and preselected so the cursor opens on it.
 * Human-only; callers gate on isHuman(). `now` is injectable for deterministic
 * tests and defaults to the current time.
 */
export async function pickInstance(
  app: Application,
  message: string,
  currentInstanceId?: string,
  now: number = Date.now(),
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
      return [option.label, option.value, option.environment].some((value) =>
        value.toLowerCase().includes(needle),
      );
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
        const label =
          option.kind === "branch" && !searching
            ? `${option.tree}${option.instance?.branch_name ?? option.label}`
            : option.label;
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
