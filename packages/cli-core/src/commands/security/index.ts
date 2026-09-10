import { createOption } from "@commander-js/extra-typings";
import type { Program } from "../../cli-program.ts";
import { collectOptionValues } from "../../lib/option-parsers.ts";
import { securityAudit } from "./audit.ts";
import { securityFix } from "./fix.ts";
import { securityChecks } from "./list-checks.ts";
import { findCheck } from "./catalog.ts";
import { FAIL_ON_LEVELS } from "./types.ts";

const PASSWORDLESS_STRATEGIES = findCheck("passwordless-auth")!.decision!.options.map(
  (o) => o.value,
);

export function registerSecurity(program: Program): void {
  const security = program
    .command("security")
    .description("Audit an instance against Clerk's security recommendations")
    .setExamples([
      { command: "clerk security", description: "Audit the linked development instance" },
      {
        command: "clerk security audit --instance prod --json",
        description: "Machine-readable audit of production",
      },
      { command: "clerk security fix --all", description: "Apply every fixable recommendation" },
      {
        command: "clerk security checks",
        description: "List the recommendations the audit checks",
      },
    ]);

  security
    .command("audit", { isDefault: true })
    .description("Evaluate the instance and report unmet recommendations")
    .option("--app <id>", "Application ID to target (works from any directory)")
    .option("--instance <id>", "Instance to target (dev, prod, or a full instance ID)")
    .option("--json", "Output the report as JSON")
    .option("--spotlight", "Only show unmet and blocked recommendations")
    .addOption(
      createOption(
        "--fail-on <level>",
        "Lowest severity of an unmet recommendation that makes the command exit 1",
      )
        .choices(FAIL_ON_LEVELS)
        .default("critical"),
    )
    .setExamples([
      { command: "clerk security audit", description: "Audit the linked development instance" },
      {
        command: "clerk security audit --instance prod --spotlight",
        description: "Only show gaps on production",
      },
      { command: "clerk security audit --json", description: "Emit the report as JSON" },
      {
        command: "clerk security audit --fail-on none",
        description: "Report without failing the exit code",
      },
    ])
    .action(securityAudit);

  security
    .command("fix")
    .description("Apply the config patch for one or more recommendations")
    .argument(
      "[ids...]",
      "Recommendation ids to fix (shown in the audit); omit to pick interactively",
    )
    .option(
      "--check <id>",
      "Recommendation id to fix (repeatable; for --input-json)",
      collectOptionValues,
    )
    .option("--all", "Fix every unmet critical and recommended check that has an inline patch")
    .option("--good-to-have", "With --all, also apply the good-to-have tier")
    .option(
      "--factors <list>",
      "Second factors for `mfa`: authenticator, backup-code, sms (comma-separated; asked interactively when omitted)",
      collectOptionValues,
    )
    .addOption(
      createOption(
        "--strategy <name>",
        "Sign-in method for `passwordless-auth` (asked interactively when omitted)",
      ).choices(PASSWORDLESS_STRATEGIES),
    )
    .option("--app <id>", "Application ID to target (works from any directory)")
    .option("--instance <id>", "Instance to target (dev, prod, or a full instance ID)")
    .option("--dry-run", "Validate server-side and preview the diff without applying it")
    .option("--yes", "Skip the confirmation prompt (required in agent mode)")
    .option("--json", "Output the result summary as JSON")
    .setExamples([
      { command: "clerk security fix", description: "Pick the recommendations to apply" },
      {
        command: "clerk security fix user-lockout device-trust",
        description: "Fix two recommendations by id",
      },
      {
        command: "clerk security fix mfa --factors authenticator,backup-code",
        description: "Enable two-factor authentication with the given factors",
      },
      {
        command: "clerk security fix --all --dry-run",
        description: "Preview every fixable change",
      },
      {
        command: "clerk security fix --all --instance prod --yes",
        description: "Fix production without prompting",
      },
      {
        command: "clerk security fix --all --good-to-have",
        description: "Include the good-to-have tier",
      },
    ])
    .action(async (ids, options) => securityFix(ids, options));

  security
    .command("checks")
    .description("List the recommendations the audit checks, without contacting Clerk")
    .option("--json", "Output the catalog as JSON")
    .setExamples([
      { command: "clerk security checks", description: "List recommendation ids by severity" },
      { command: "clerk security checks --json", description: "Emit the catalog as JSON" },
    ])
    .action(securityChecks);
}
