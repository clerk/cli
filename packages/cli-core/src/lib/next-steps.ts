import { cyan } from "./color.ts";
import { isHuman } from "../mode.ts";
import { log } from "./log.ts";

export const NEXT_STEPS = {
  LOGIN: [
    "Run `clerk init` to set up Clerk in your project",
    "Run `clerk link` to connect an existing Clerk application",
  ],
  LOGIN_LINKED: ["Run `clerk link` to connect a different Clerk application"],
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
  AUTOCLAIMED: ["Run `clerk doctor` to verify your setup"],
  AUTOCLAIMED_NO_ENV: [
    "Run `clerk env pull` to refresh your environment variables",
    "Run `clerk doctor` to verify your setup",
  ],
  AUTOCLAIM_MANUAL_LINK: [
    "Run `clerk link` to connect your Clerk application",
    "Run `clerk env pull` to fetch your environment variables",
  ],
  AUTOCLAIM_RETRY: [
    "Run `clerk auth login` again to retry auto-claim",
    "Run `clerk link` to connect your application manually",
  ],
  ENABLE_ORGS: [
    "Run `clerk config schema --keys organization_settings` to see all available settings",
    "Run `clerk config pull --keys organization_settings` to see current values",
  ],
  ENABLE_BILLING: [
    "Run `clerk config schema --keys billing` to see all available settings",
    "Run `clerk config pull --keys billing` to see current values",
  ],
  ENABLE_API_KEYS: [
    "Run `clerk config schema --keys api_keys_settings` to see all available settings",
    "Run `clerk config pull --keys api_keys_settings` to see current values",
    "Run `clerk open api-keys` to manage API Keys in the Dashboard",
  ],
  SWITCH_ENV: [
    "Run `clerk env pull` to fetch environment variables for this environment",
    "Run `clerk doctor` to verify your setup",
  ],
  SWITCH_ENV_NO_TOKEN: [
    "Run `clerk auth login` to authenticate for this environment",
    "Run `clerk env pull` to fetch environment variables",
  ],
  UNLINK: [
    "Run `clerk link` to connect this directory to a different application",
    "Run `clerk apps list` to browse your applications",
  ],
  SKILL_INSTALL: [
    "Start a new Claude Code or Codex session — the skill is now active for this project",
    "Or run `clerk init` to scaffold Clerk yourself",
  ],
  CONFIG_PUSH: [
    "Run `clerk config pull` to confirm the live configuration",
    "Run `clerk doctor` to verify your setup",
  ],
  CONFIG_DRY_RUN_PATCH: ["Run `clerk config patch` without `--dry-run` to apply these changes"],
  CONFIG_DRY_RUN_PUT: ["Run `clerk config put` without `--dry-run` to apply these changes"],
  LOGOUT: ["Run `clerk auth login` to sign in again"],
  WHOAMI: ["Run `clerk link` to connect this directory to an application"],
  WHOAMI_LINKED: [
    "Run `clerk apps list` to see your other applications",
    "Run `clerk config pull` to inspect the live configuration of this instance",
  ],
} as const;

/**
 * Print contextual next-step suggestions after a successful command.
 * Only shown in human/interactive mode — agents get AGENT_PROMPT instead.
 */
export function printNextSteps(steps: readonly string[]): void {
  if (!isHuman() || steps.length === 0) return;
  for (const step of steps) {
    log.info(`   ${cyan("\u2192")} ${step}`);
  }
  log.blank();
}
