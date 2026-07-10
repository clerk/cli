import type { Program } from "../../cli-program.ts";
import { branchSwitch, applySwitchOptions } from "../branch/switch.ts";

/**
 * Register the top-level alias for branch switch.
 */
export function registerSwitch(program: Program): void {
  // Options come from applySwitchOptions so this alias and `clerk branch
  // switch` (see ../branch/index.ts) share one option surface.
  applySwitchOptions(
    program
      .command("switch")
      .description(
        "Set the active Clerk instance for this worktree (alias of `clerk branch switch`)",
      ),
  )
    .setExamples([
      { command: "clerk switch agent/pr-42", description: "Switch to a branch" },
      {
        command: "clerk switch -c agent/pr-99",
        description: "Fork the development instance and switch",
      },
      { command: "clerk switch -", description: "Toggle to the previous instance" },
    ])
    .action((target, opts) => branchSwitch(target, opts));
}
