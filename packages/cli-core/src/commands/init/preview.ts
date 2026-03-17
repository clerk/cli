import { confirm } from "@inquirer/prompts";
import { cyan, dim, green, yellow } from "../../lib/color.js";
import type { ScaffoldPlan } from "./frameworks/types.js";

export async function previewAndConfirm(plan: ScaffoldPlan): Promise<boolean> {
  console.log("\nclerk init will make the following changes:\n");

  for (const action of plan.actions) {
    if (action.skipReason) {
      console.log(`  ${dim("SKIP")}    ${dim(action.path)} — ${dim(action.skipReason)}`);
    } else if (action.type === "create") {
      console.log(`  ${green("CREATE")}  ${cyan(action.path)}`);
    } else {
      console.log(`  ${yellow("MODIFY")}  ${cyan(action.path)} — ${action.description}`);
    }
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
