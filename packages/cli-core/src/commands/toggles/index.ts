import type { Command } from "@commander-js/extra-typings";
import { orgsEnable, orgsDisable } from "../orgs/index.ts";
import { billingEnable, billingDisable } from "../billing/index.ts";

/**
 * Registers the `enable` and `disable` feature-toggle commands.
 *
 * These two parents are shared by multiple feature folders (orgs, billing), so
 * neither feature owns them cleanly — this registrar builds both parents and
 * wires each feature's enable/disable handlers under them, grouping by parent
 * rather than by feature.
 */
export function registerToggles(program: Command): void {
  const enable = program
    .command("enable")
    .description("Enable Clerk features on the linked instance")
    .setExamples([
      { command: "clerk enable orgs", description: "Enable organizations" },
      {
        command: "clerk enable orgs --force-selection --max-members 10",
        description: "Enable organizations with options",
      },
      {
        command: "clerk enable billing --for orgs",
        description: "Enable billing for organizations only",
      },
      {
        command: "clerk enable billing",
        description: "Enable billing for organizations and users",
      },
    ]);

  enable
    .command("orgs")
    .alias("organizations")
    .description("Enable organizations on the linked instance")
    .option("--app <id>", "Application ID to target")
    .option("--instance <id>", "Instance to target (dev, prod, or instance ID)")
    .option("--force-selection", "Force organization selection on login")
    .option("--auto-create", "Auto-create an organization for new users")
    .option("--max-members <n>", "Maximum members per organization")
    .option("--domains", "Enable verified domains")
    .option("--yes", "Skip confirmation prompts")
    .option("--dry-run", "Show the patch that would be sent without applying it")
    .setExamples([
      { command: "clerk enable orgs", description: "Enable organizations" },
      {
        command: "clerk enable orgs --force-selection",
        description: "Enable and force org selection",
      },
      {
        command: "clerk enable orgs --auto-create --max-members 10",
        description: "Enable with auto-creation and member limit",
      },
      {
        command: "clerk enable orgs --dry-run",
        description: "Preview the patch without applying it",
      },
    ])
    .action(orgsEnable);

  enable
    .command("billing")
    .description("Enable billing for organizations and/or users")
    .option(
      "--for <targets...>",
      "Billing targets (orgs and/or users), separated by spaces or commas (e.g. orgs users). Defaults to both when omitted.",
    )
    .option("--app <id>", "Application ID to target")
    .option("--instance <id>", "Instance to target (dev, prod, or instance ID)")
    .option("--yes", "Skip confirmation prompts")
    .option("--dry-run", "Show the patch that would be sent without applying it")
    .option("--no-skills", "Skip the optional `clerk-billing` agent skill install")
    .setExamples([
      {
        command: "clerk enable billing",
        description: "Enable billing for organizations and users",
      },
      {
        command: "clerk enable billing --for orgs",
        description: "Enable billing for organizations only",
      },
      {
        command: "clerk enable billing --for users",
        description: "Enable billing for users only",
      },
      {
        command: "clerk enable billing --for orgs users",
        description: "Enable billing for both targets",
      },
      {
        command: "clerk enable billing --no-skills",
        description: "Enable without installing the agent skill",
      },
    ])
    .action(billingEnable);

  const disable = program
    .command("disable")
    .description("Disable Clerk features on the linked instance")
    .setExamples([
      { command: "clerk disable orgs", description: "Disable organizations" },
      {
        command: "clerk disable billing --for orgs",
        description: "Disable billing for organizations only (leaves organizations enabled)",
      },
      {
        command: "clerk disable billing",
        description: "Disable billing for organizations and users",
      },
    ]);

  disable
    .command("orgs")
    .alias("organizations")
    .description("Disable organizations on the linked instance")
    .option("--app <id>", "Application ID to target")
    .option("--instance <id>", "Instance to target (dev, prod, or instance ID)")
    .option("--yes", "Skip confirmation prompts")
    .option("--dry-run", "Show the patch that would be sent without applying it")
    .setExamples([
      { command: "clerk disable orgs", description: "Disable organizations" },
      {
        command: "clerk disable orgs --dry-run",
        description: "Preview without applying",
      },
    ])
    .action(orgsDisable);

  disable
    .command("billing")
    .description(
      "Disable billing for organizations and/or users (does not disable organizations themselves)",
    )
    .option(
      "--for <targets...>",
      "Billing targets (orgs and/or users), separated by spaces or commas (e.g. orgs users). Defaults to both when omitted.",
    )
    .option("--app <id>", "Application ID to target")
    .option("--instance <id>", "Instance to target (dev, prod, or instance ID)")
    .option("--yes", "Skip confirmation prompts")
    .option("--dry-run", "Show the patch that would be sent without applying it")
    .setExamples([
      {
        command: "clerk disable billing",
        description: "Disable billing for organizations and users",
      },
      {
        command: "clerk disable billing --for orgs",
        description: "Disable billing for organizations only",
      },
      {
        command: "clerk disable billing --for users",
        description: "Disable billing for users only",
      },
    ])
    .action(billingDisable);
}
