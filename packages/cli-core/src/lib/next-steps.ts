import { cyan } from "./color.ts";
import type { Need } from "./deps.ts";

export const NEXT_STEPS = {
  LOGIN: [
    "Run `clerk init` to set up Clerk in your project",
    "Run `clerk link` to connect an existing Clerk application",
  ],
  LINK: [
    "Run `clerk env pull` to fetch your environment variables",
    "Run `clerk doctor` to verify your setup",
  ],
  CREATE: [
    "Run `clerk link` to connect this app to your project",
    "Run `clerk env pull` to fetch your environment variables",
  ],
  DEPLOY: [
    "Run `clerk env pull --instance prod` to fetch production keys",
    "Run `clerk doctor` to verify your setup",
  ],
} as const;

export type PrintNextStepsDeps = Need<{
  log: "info" | "blank";
}>;

/**
 * Print contextual next-step suggestions after a successful command.
 *
 * Callers are responsible for gating this on interactive/human mode via
 * deps.mode.isAgent() before calling.
 */
export function printNextSteps(deps: PrintNextStepsDeps, steps: readonly string[]): void {
  if (steps.length === 0) return;
  for (const step of steps) {
    deps.log.info(`   ${cyan("\u2192")} ${step}`);
  }
  deps.log.blank();
}
