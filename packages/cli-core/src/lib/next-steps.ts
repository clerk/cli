import { cyan, dimNeutral } from "./color.ts";
import { isHuman } from "../mode.ts";

export const NEXT_STEPS = {
  LOGIN: [
    "Run `clerk init` to set up Clerk in your project",
    "Run `clerk link` to connect an existing Clerk application",
  ],
  LINK: [
    "Run `clerk env pull` to fetch your environment variables",
    "Run `clerk doctor` to verify your setup",
  ],
  DEPLOY: [
    "Run `clerk env pull --instance prod` to fetch production keys",
    "Run `clerk doctor` to verify your setup",
  ],
} as const;

/**
 * Print contextual next-step suggestions after a successful command.
 * Only shown in human/interactive mode — agents get AGENT_PROMPT instead.
 */
export function printNextSteps(steps: readonly string[]): void {
  if (!isHuman() || steps.length === 0) return;
  for (const step of steps) {
    console.error(`   ${cyan("\u2192")} ${step}`);
  }
  console.error();
}
