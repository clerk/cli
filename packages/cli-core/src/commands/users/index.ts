import { createOption, createArgument } from "@commander-js/extra-typings";
import type { Program } from "../../cli-program.ts";
import { parseIntegerOption, collectOptionValues } from "../../lib/option-parsers.ts";
import { create } from "./create.ts";
import { list } from "./list.ts";
import { usersMenu } from "./menu.ts";
import { open } from "./open.ts";

export type { UsersActionTargeting, UsersAction } from "./registry.ts";
export {
  registerUsersAction,
  listUsersActions,
  __resetUsersActionRegistryForTesting,
} from "./registry.ts";

const users = {
  create,
  list,
  menu: usersMenu,
  open,
};

const USER_LIST_ORDER_BY_FIELDS = [
  "created_at",
  "email_address",
  "first_name",
  "last_name",
  "phone_number",
  "username",
  "last_sign_in_at",
] as const;

const USER_LIST_ORDER_BY_CHOICES = USER_LIST_ORDER_BY_FIELDS.flatMap((field) => [
  field,
  `+${field}`,
  `-${field}`,
]);

export function registerUsers(program: Program): void {
  const usersCommand = program
    .command("users")
    .description("Manage Clerk users")
    .option("--secret-key <key>", "Backend API secret key to use")
    .option("--app <id>", "Application ID to target (works from any directory)")
    .option("--instance <id>", "Instance to target (dev, prod, or a full instance ID)")
    .option("--branch <name>", "Target a branch by name (e.g. agent/pr-42)")
    .setExamples([
      { command: "clerk users list", description: "List users" },
      {
        command: "clerk users create --email alice@example.com --first-name Alice --yes",
        description: "Create a user from curated flags",
      },
      {
        command: 'clerk users create -d \'{"email_address":["alice@example.com"]}\' --yes',
        description: "Create a user from an inline BAPI request body",
      },
    ])
    .action((_opts, cmd) => users.menu(cmd.optsWithGlobals() as Parameters<typeof users.menu>[0]));

  usersCommand
    .command("list")
    .description("List users")
    .option("--json", "Output as JSON")
    .option("--limit <number>", "Maximum users to return (1-250, default 100)", (value) =>
      parseIntegerOption(value, "--limit", { min: 1, max: 250 }),
    )
    .option("--offset <number>", "Users to skip before returning results (0+)", (value) =>
      parseIntegerOption(value, "--offset", { min: 0 }),
    )
    .option("--query <query>", "Search across common user fields")
    .option(
      "--email-address <email>",
      "Filter by email address (repeat or comma-separate)",
      collectOptionValues,
      [],
    )
    .option(
      "--phone-number <phone>",
      "Filter by phone number (repeat or comma-separate)",
      collectOptionValues,
      [],
    )
    .option(
      "--username <username>",
      "Filter by username (repeat or comma-separate)",
      collectOptionValues,
      [],
    )
    .option(
      "--user-id <user-id>",
      "Filter by user ID (repeat or comma-separate)",
      collectOptionValues,
      [],
    )
    .option(
      "--external-id <external-id>",
      "Filter by external ID (repeat or comma-separate)",
      collectOptionValues,
      [],
    )
    .addOption(
      createOption(
        "--order-by <field>",
        "Order by a supported field, optionally prefixed with + or -",
      ).choices(USER_LIST_ORDER_BY_CHOICES),
    )
    .option("--secret-key <key>", "Backend API secret key to use")
    .option("--app <id>", "Application ID to target (works from any directory)")
    .option("--instance <id>", "Instance to target (dev, prod, or a full instance ID)")
    .option("--branch <name>", "Target a branch by name (e.g. agent/pr-42)")
    .setExamples([
      { command: "clerk users list", description: "List users with the default ordering" },
      {
        command: "clerk users list --query alice --limit 20",
        description: "Search across common user fields with pagination",
      },
      {
        command:
          "clerk users list --email-address alice@example.com --external-id crm_123 --order-by -last_sign_in_at",
        description: "Filter by common identifiers and sort by recent sign-in",
      },
    ])
    .action((_opts, cmd) => users.list(cmd.optsWithGlobals() as Parameters<typeof users.list>[0]));

  usersCommand
    .command("create")
    .description("Create a user")
    .option("--json", "Output as JSON")
    .option("--email <email>", "Email address")
    .option("--phone <phone>", "Phone number")
    .option("--username <username>", "Username")
    .option("--password <password>", "Password")
    .option("--first-name <first-name>", "First name")
    .option("--last-name <last-name>", "Last name")
    .option("--external-id <external-id>", "External ID")
    .option("-d, --data <json>", "Inline BAPI request body")
    .option("--file <path>", "Read BAPI request body from a file")
    .option("--dry-run", "Show the request without executing it")
    .option("--yes", "Skip confirmation prompt")
    .setExamples([
      {
        command: "clerk users create --email alice@example.com --first-name Alice --yes",
        description: "Create a user from curated flags",
      },
      {
        command: 'clerk users create -d \'{"email_address":["alice@example.com"]}\' --yes',
        description: "Create a user from an inline BAPI request body",
      },
      {
        command: "clerk users create --file user.json --dry-run",
        description: "Preview a request from a file without executing",
      },
    ])
    .action((_opts, cmd) =>
      users.create(cmd.optsWithGlobals() as Parameters<typeof users.create>[0]),
    );

  usersCommand
    .command("open")
    .description("Open a user's dashboard page in your browser")
    .addArgument(createArgument("[user-id]", "User ID to open. Omit to pick interactively."))
    .option("--print", "Print the URL without opening the browser")
    .option("--secret-key <key>", "Backend API secret key to use")
    .option("--app <id>", "Application ID to target (works from any directory)")
    .option("--instance <id>", "Instance to target (dev, prod, or a full instance ID)")
    .option("--branch <name>", "Target a branch by name (e.g. agent/pr-42)")
    .setExamples([
      { command: "clerk users open", description: "Pick app (if not linked) and user, then open" },
      {
        command: "clerk users open user_2x9k",
        description: "Open a specific user (pick app if not linked)",
      },
      {
        command: "clerk users open user_2x9k --app app_123",
        description: "Open a specific user against an explicit app",
      },
      {
        command: "clerk users open user_2x9k --print",
        description: "Print the dashboard URL instead of opening",
      },
    ])
    .action((userId, _opts, cmd) =>
      users.open({
        ...(cmd.optsWithGlobals() as Parameters<typeof users.open>[0]),
        userId,
      }),
    );
}
