import { cyan, dimNeutral } from "./color.ts";
import { isHuman } from "../mode.ts";

/**
 * Print contextual next-step suggestions after a successful command.
 * Only shown in human/interactive mode — agents get AGENT_PROMPT instead.
 */
export function printNextSteps(steps: string[]): void {
  if (!isHuman() || steps.length === 0) return;
  console.error(`\n${dimNeutral("Next steps:")}`);
  for (const step of steps) {
    console.error(`  ${cyan("\u2192")} ${step}`);
  }
}
