import type { Program } from "../../cli-program.ts";
import { branchCreate } from "./create.ts";
import { branchList } from "./list.ts";
import { branchDelete } from "./delete.ts";
import { branchSwitch, applySwitchOptions } from "./switch.ts";

/**
 * Register the branch command group and its create, list, delete, and switch commands.
 */
export function registerBranch(program: Program): void {
  const branch = program
    .command("branch")
    .description("Fork, list, and delete instance branches")
    .setExamples([
      {
        command: "clerk branch create",
        description: "Fork interactively, prompting for the branch name",
      },
      {
        command: "clerk branch create --name agent/pr-42",
        description: "Fork the development instance into a branch",
      },
      {
        command: "clerk branch create --name agent/pr-42 --switch",
        description: "Fork and switch this worktree to the new branch",
      },
      { command: "clerk branch list", description: "List branches" },
      {
        command: "clerk branch delete agent/pr-42 --yes",
        description: "Delete a branch without confirmation",
      },
    ]);

  branch
    .command("create")
    .description("Fork an instance into a new branch (a development instance)")
    .option("--name <name>", "Branch name (e.g. agent/pr-42); prompted when omitted")
    .option("--app <id>", "Application ID to target (works from any directory)")
    .option("-s, --switch", "Switch this worktree to the new branch after creating it")
    .option("--json", "Output as JSON")
    .action(branchCreate);

  branch
    .command("list")
    .description("List branches for the application")
    .option("--app <id>", "Application ID to target (works from any directory)")
    .option("--json", "Output as JSON")
    .action(branchList);

  branch
    .command("delete")
    .description("Delete a branch")
    .argument("<name>", "Branch name")
    .option("--app <id>", "Application ID to target (works from any directory)")
    .option("--yes", "Skip the confirmation prompt (required in agent mode)")
    .option("--json", "Output as JSON")
    .action((name, opts) => branchDelete({ ...opts, name }));

  // Options come from applySwitchOptions so this subcommand and the top-level
  // `clerk switch` alias (see ../switch/index.ts) share one option surface.
  applySwitchOptions(
    branch
      .command("switch")
      .description("Set the active instance for this worktree (dev, prod, or a branch)"),
  )
    .setExamples([
      { command: "clerk branch switch agent/pr-42", description: "Switch to a branch" },
      {
        command: "clerk branch switch -c agent/pr-99",
        description: "Fork the development instance and switch",
      },
      { command: "clerk branch switch -", description: "Toggle to the previous instance" },
    ])
    .action((target, opts) => branchSwitch(target, opts));
}
