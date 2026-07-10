import type { Program } from "../../cli-program.ts";
import { status } from "./status.ts";

/**
 * Register the status command.
 */
export function registerStatus(program: Program): void {
  program
    .command("status")
    .description("Show the active instance, git binding, and app for this worktree")
    .option("--json", "Output as JSON")
    .setExamples([{ command: "clerk status", description: "Show the active instance" }])
    .action(status);
}
