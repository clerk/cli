import type { Program } from "../../cli-program.ts";
import { branchCreate } from "./create.ts";
import { branchList } from "./list.ts";
import { branchDelete } from "./delete.ts";
import { branchDiff } from "./diff.ts";

export function registerBranch(program: Program): void {
  const branch = program
    .command("branch")
    .description("Fork, list, diff, and delete instance branches")
    .setExamples([
      {
        command: "clerk branch create --name agent/pr-42 --from production",
        description: "Fork production into a branch",
      },
      { command: "clerk branch list", description: "List branches" },
      {
        command: "clerk branch diff agent/pr-42 --against prod",
        description: "Diff a branch against production",
      },
      { command: "clerk branch delete agent/pr-42", description: "Delete a branch" },
    ]);

  branch
    .command("create")
    .description("Fork an instance into a new branch (a development instance)")
    .requiredOption("--name <name>", "Branch name (e.g. agent/pr-42)")
    .option("--from <id>", "Parent instance to fork (dev, prod, or instance ID)", "production")
    .option("--app <id>", "Application ID to target (works from any directory)")
    .action(branchCreate);

  branch
    .command("list")
    .description("List branches for the application")
    .option("--app <id>", "Application ID to target (works from any directory)")
    .action(branchList);

  branch
    .command("delete")
    .description("Delete a branch")
    .argument("<name>", "Branch name")
    .option("--app <id>", "Application ID to target (works from any directory)")
    .action((name, opts) => branchDelete({ ...opts, name }));

  branch
    .command("diff")
    .description("Diff a branch's config against another instance")
    .argument("<name>", "Branch name")
    .option("--against <id>", "Instance to diff against (default: production)", "production")
    .option("--app <id>", "Application ID to target (works from any directory)")
    .action((name, opts) => branchDiff({ ...opts, name }));
}
