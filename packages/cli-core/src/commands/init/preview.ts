import { confirm } from "@inquirer/prompts";
import { cyan, dim, green, yellow } from "../../lib/color.js";
import type { FileAction, ScaffoldPlan } from "./frameworks/types.js";

function formatAction(action: FileAction): string {
  switch (action.type) {
    case "skip":
      return `  ${dim("SKIP")}    ${dim(action.path)} — ${dim(action.skipReason)}`;
    case "create":
      return `  ${green("CREATE")}  ${cyan(action.path)}`;
    case "modify":
      return `  ${yellow("MODIFY")}  ${cyan(action.path)} — ${action.description}`;
  }
}

export async function previewAndConfirm(plan: ScaffoldPlan): Promise<boolean> {
  console.log("\nclerk init will make the following changes:\n");

  for (const action of plan.actions) {
    console.log(formatAction(action));
  }

  if (plan.postInstructions.length > 0) {
    console.log(dim("\n  After scaffolding, you'll need to:"));
    for (const instr of plan.postInstructions) {
      console.log(dim(`  • ${instr}`));
    }
  }

  console.log();
  return confirm({ message: "Proceed?" });
}
