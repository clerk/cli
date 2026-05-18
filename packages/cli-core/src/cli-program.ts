import { Command, createOption, createArgument } from "@commander-js/extra-typings";
import { expandInputJson } from "./lib/input-json.ts";
import { setLogLevel } from "./lib/log.ts";
import { setMode, type Mode } from "./mode.ts";
import { init } from "./commands/init/index.ts";
import { login } from "./commands/auth/login.ts";
import { logout } from "./commands/auth/logout.ts";
import { whoami } from "./commands/whoami/index.ts";
import { pull } from "./commands/env/pull.ts";
import { configPull } from "./commands/config/pull.ts";
import { configPatch, configPut } from "./commands/config/push.ts";
import { configSchema } from "./commands/config/schema.ts";
import { api } from "./commands/api/index.ts";
import { link } from "./commands/link/index.ts";
import { unlink } from "./commands/unlink/index.ts";
import { apps as appsHandlers } from "./commands/apps/index.ts";
import { users as usersHandlers } from "./commands/users/index.ts";
import { doctor } from "./commands/doctor/index.ts";
import { switchEnv } from "./commands/switch-env/index.ts";
import { openDashboard } from "./commands/open/index.ts";
import { getEnvironment } from "./lib/config.ts";
import {
  setCurrentEnv,
  isValidEnv,
  getCurrentEnvName,
  getAvailableEnvs,
  getPlapiBaseUrl,
} from "./lib/environment.ts";
import { completion, SUPPORTED_SHELLS } from "./commands/completion/index.ts";
import { FRAMEWORK_NAMES } from "./lib/framework.ts";
import { PACKAGE_MANAGERS } from "./lib/package-manager.ts";
import {
  CliError,
  UserAbortError,
  ApiError,
  PlapiError,
  FapiError,
  EXIT_CODE,
  isPromptExitError,
  throwUsageError,
} from "./lib/errors.ts";
import { clerkHelpConfig } from "./lib/help.ts";
import { isAgent } from "./mode.ts";
import { log } from "./lib/log.ts";
import { maybeNotifyUpdate, getCurrentVersion } from "./lib/update-check.ts";
import { update } from "./commands/update/index.ts";
import { deploy } from "./commands/deploy/index.ts";
import { deployStatus } from "./commands/deploy/status-command.ts";
import { orgsEnable, orgsDisable } from "./commands/orgs/index.ts";
import { billingEnable, billingDisable } from "./commands/billing/index.ts";
import { registerExtras } from "@clerk/cli-extras";

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

const APPS_JSON_FIELDS =
  "Output as JSON. Fields: application_id, name, instances[] (instance_id, environment_type, publishable_key)";

const TOKEN_OPTION_DESC =
  "Headless authentication with a Clerk PLAPI access token (skips OAuth; use `-` to read from stdin). For per-instance API access, CLERK_SECRET_KEY also works directly with `clerk api` / `users` / `config`.";

function collectOptionValues(value: string, previous: string[] = []): string[] {
  return [...previous, value];
}

function parseIntegerOption(
  value: string,
  flag: string,
  { min, max }: { min: number; max?: number },
): number {
  if (!/^-?\d+$/.test(value)) {
    throwUsageError(`Invalid ${flag} value "${value}". Must be an integer.`);
  }

  const parsed = Number.parseInt(value, 10);
  if (parsed < min || (typeof max === "number" && parsed > max)) {
    const range = typeof max === "number" ? `${min}-${max}` : `>= ${min}`;
    throwUsageError(`Invalid ${flag} value "${value}". Must be ${range}.`);
  }

  return parsed;
}

export function createProgram() {
  const program = new Command()
    .name("clerk")
    .description("Clerk CLI")
    .configureHelp(clerkHelpConfig())
    .configureOutput({
      writeOut: (msg) => log.data(msg.replace(/\n$/, "")),
      writeErr: (msg) => log.ui(msg),
    })
    .version(getCurrentVersion(), "-v, --version", "Output the version number")
    .helpOption("-h, --help", "Display help for command")
    .addHelpCommand("help [command]", "Display help for command")
    .option(
      "--input-json <json>",
      "Pass command options as a JSON string, @file.json, or - for stdin",
    )
    .option(
      "--mode <mode>",
      "Force interaction mode (human or agent). Defaults to auto-detect based on TTY.",
    )
    .option("--verbose", "Show detailed output (enables debug messages)")
    .option("--quiet", "Suppress non-essential output (info, warnings, spinners)")
    .setExamples([
      { command: "clerk init", description: "Initialize Clerk in this project" },
      { command: "clerk auth login", description: "Authenticate via browser OAuth" },
      {
        command: "clerk apps list --json",
        description: "List applications as JSON (agent-pipeable)",
      },
      {
        command: "clerk users list --json | jq '.data'",
        description: "Pipe user list to jq",
      },
      {
        command: "clerk --mode agent api /users",
        description: "Force agent mode for non-interactive use",
      },
    ])
    .setEnvVars([
      {
        name: "CLERK_SECRET_KEY",
        description: "Backend API secret key for the linked instance (sk_test_… / sk_live_…)",
      },
      {
        name: "CLERK_MODE",
        description: "Force interaction mode: human or agent (default: TTY auto-detect)",
      },
      {
        name: "CLERK_CONFIG_DIR",
        description: "Override the directory for stored credentials and config",
      },
      {
        name: "CLERK_UPDATE_CHANNEL",
        description: "Release channel for `clerk update` (e.g. latest, canary)",
      },
      {
        name: "CLERK_NO_UPDATE_CHECK",
        description: "Set to any value to disable the post-command update notification",
      },
    ])
    .addHelpText(
      "after",
      `
Next:
  $ clerk auth login           Authenticate (or set CLERK_SECRET_KEY for headless use)
  $ clerk init                 Set up Clerk in this project
  $ clerk doctor               Check that everything is wired up

Documentation:
  https://clerk.com/docs/cli
  https://github.com/clerk/cli`,
    );

  program.hook("preAction", async () => {
    // Reset log level at the start of each command invocation so a previous
    // --verbose doesn't leak into subsequent runs.
    setLogLevel("info");
    const opts = program.opts();
    if (opts.verbose && opts.quiet) {
      throwUsageError("--verbose and --quiet are mutually exclusive");
    }
    if (opts.verbose) {
      setLogLevel("debug");
    } else if (opts.quiet) {
      setLogLevel("error");
    }
    if (opts.mode) {
      if (opts.mode !== "human" && opts.mode !== "agent") {
        throwUsageError(`Invalid mode "${opts.mode}". Must be "human" or "agent".`);
      }
      setMode(opts.mode as Mode);
    }

    // Initialize the active environment from persisted config
    const envName = await getEnvironment();
    if (envName && isValidEnv(envName)) {
      setCurrentEnv(envName); // logs env + platformApiUrl
    } else {
      if (envName) {
        log.warn(
          `Saved environment "${envName}" is not available in this binary. Falling back to production.`,
        );
        log.warn(`Available environments: ${getAvailableEnvs().join(", ")}`);
      }
      log.debug(`env: active environment is "production" (platformApiUrl=${getPlapiBaseUrl()})`);
    }

    // Print environment banner to stderr when not on production,
    // so it doesn't pollute stdout for piped commands.
    const activeEnv = getCurrentEnvName();
    if (activeEnv !== "production") {
      process.stderr.write(`[${activeEnv.toUpperCase()}]\n`);
    }
  });

  // Show update notification after each command, except for commands that
  // already perform their own version check (doctor, update).
  program.hook("postAction", async (_thisCommand, actionCommand) => {
    const cmdName = actionCommand.name();
    if (cmdName === "doctor" || cmdName === "update") return;
    await maybeNotifyUpdate(getCurrentVersion());
  });

  program
    .command("init")
    .description("Initialize Clerk in your project")
    .addOption(
      createOption("--framework <name>", "Framework to set up (skips auto-detection)").choices(
        FRAMEWORK_NAMES,
      ),
    )
    .addOption(
      createOption(
        "--pm <manager>",
        "Package manager to use (skips prompt/auto-detection)",
      ).choices(PACKAGE_MANAGERS),
    )
    .option("--name <project-name>", "Project name for --starter (skips prompt)")
    .option("--app <id>", "Application ID to link (skips interactive picker)")
    .option("--starter", "Create a new project from a starter template")
    .option(
      "--keyless",
      "Use keyless development keys instead of logging in (only for keyless-capable frameworks)",
    )
    .option("-y, --yes", "Skip confirmation prompts")
    .option("--no-skills", "Skip the optional agent skills install prompt")
    .setExamples([
      { command: "clerk init", description: "Auto-detect framework and set up Clerk" },
      {
        command: "clerk init --framework next",
        description: "Set up for Next.js (skips detection)",
      },
      {
        command: "clerk init --app app_123",
        description: "Link to a specific Clerk application",
      },
      { command: "clerk init --starter", description: "Create a new project with Clerk" },
      {
        command: "clerk init --starter --framework next --pm bun",
        description: "Bootstrap with Bun",
      },
      {
        command: "clerk init --starter --framework next --keyless",
        description: "Bootstrap without logging in (uses temporary dev keys)",
      },
      { command: "clerk init -y", description: "Skip all confirmation prompts" },
      { command: "clerk init --no-skills", description: "Skip the agent skills install prompt" },
    ])
    .action(init);

  const auth = program
    .command("auth")
    .description("Manage authentication")
    .setExamples([
      { command: "clerk auth login", description: "Log in via browser (OAuth)" },
      { command: "clerk auth logout", description: "Remove stored credentials" },
    ]);

  auth
    .command("login")
    .aliases(["signup", "signin", "sign-in"])
    .description("Log in to your Clerk account")
    .option("-y, --yes", "Proceed with OAuth without prompting when already logged in")
    .option("--token <key>", TOKEN_OPTION_DESC)
    .setExamples([
      { command: "clerk auth login", description: "Log in via browser (OAuth)" },
      {
        command: "clerk auth login -y",
        description: "Re-authenticate via OAuth without confirmation when already signed in",
      },
      {
        command: "clerk auth login --token $CLERK_OAUTH_TOKEN",
        description: "Headless login with a PLAPI access token (CI / agents)",
      },
      {
        command: "cat token.txt | clerk auth login --token -",
        description: "Read the token from stdin",
      },
    ])
    .action(async (opts) => {
      await login(opts);
    });

  auth
    .command("logout")
    .aliases(["signout", "sign-out"])
    .description("Log out of your Clerk account")
    .setExamples([{ command: "clerk auth logout", description: "Remove stored credentials" }])
    .action(logout);

  program
    .command("login", { hidden: true })
    .description("Log in to your Clerk account")
    .option("-y, --yes", "Proceed with OAuth without prompting when already logged in")
    .option("--token <key>", TOKEN_OPTION_DESC)
    .action(async (opts) => {
      await login(opts);
    });

  program
    .command("logout", { hidden: true })
    .description("Log out of your Clerk account")
    .action(logout);

  program
    .command("link")
    .description("Link this project to a Clerk application")
    .option("--app <id>", "Application ID to link (skips interactive picker)")
    .setExamples([
      { command: "clerk link", description: "Pick an app interactively" },
      { command: "clerk link --app app_abc123", description: "Link directly by application ID" },
    ])
    .action(link);

  program
    .command("unlink")
    .description("Unlink this project from its Clerk application")
    .option("--yes", "Skip confirmation prompt")
    .setExamples([
      { command: "clerk unlink", description: "Unlink with confirmation prompt" },
      { command: "clerk unlink --yes", description: "Skip confirmation" },
    ])
    .action(unlink);

  program
    .command("whoami")
    .description("Show the current logged-in user and linked application")
    .option("--json", "Output JSON")
    .setExamples([
      { command: "clerk whoami", description: "Show your email and linked app" },
      { command: "clerk whoami --json", description: "Emit a structured payload on stdout" },
    ])
    .action((options) => whoami({ json: options.json }));

  const open = program.command("open").description("Open Clerk resources in your browser");

  open
    .command("dashboard", { isDefault: true })
    .description("Open the linked app's dashboard in your browser")
    .addArgument(
      createArgument("[subpath]", "Optional dashboard subpath (e.g. users, api-keys, settings)"),
    )
    .option("--print", "Print the URL without opening the browser")
    .setExamples([
      { command: "clerk open", description: "Open the linked app's dashboard" },
      { command: "clerk open users", description: "Open the users page" },
      { command: "clerk open api-keys", description: "Open the API keys page" },
      { command: "clerk open --print", description: "Print the dashboard URL" },
    ])
    .action((subpath, options) => openDashboard(subpath, options));

  const apps = program.command("apps").description("Manage your Clerk applications");

  apps
    .command("list")
    .description("List your Clerk applications")
    .option("--json", APPS_JSON_FIELDS)
    .setExamples([
      { command: "clerk apps list", description: "List all applications" },
      { command: "clerk apps list --json", description: "Output as JSON" },
    ])
    .action(appsHandlers.list);

  apps
    .command("create")
    .description("Create a new Clerk application")
    .argument("<name>", "Application name")
    .option("--json", APPS_JSON_FIELDS)
    .setExamples([
      { command: 'clerk apps create "My App"', description: "Create a new application" },
      { command: 'clerk apps create "My App" --json', description: "Output as JSON" },
    ])
    .action(appsHandlers.create);

  const users = program
    .command("users")
    .description("Manage Clerk users")
    .option("--secret-key <key>", "Backend API secret key to use")
    .option("--app <id>", "Application ID to target (works from any directory)")
    .option("--instance <id>", "Instance to target (dev, prod, or a full instance ID)")
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
    .action((_opts, cmd) =>
      usersHandlers.menu(cmd.optsWithGlobals() as Parameters<typeof usersHandlers.menu>[0]),
    );

  users
    .command("list")
    .description("List users")
    .option(
      "--json",
      "Output as JSON. Shape: {data: User[], hasMore: boolean}. User fields: id, first_name, last_name, username, email_addresses, phone_numbers, created_at, last_sign_in_at, external_id",
    )
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
    .action((_opts, cmd) =>
      usersHandlers.list(cmd.optsWithGlobals() as Parameters<typeof usersHandlers.list>[0]),
    );

  users
    .command("create")
    .description("Create a user")
    .option(
      "--json",
      "Output as JSON. Fields: id, first_name, last_name, username, email_addresses, phone_numbers, created_at, external_id",
    )
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
      usersHandlers.create(cmd.optsWithGlobals() as Parameters<typeof usersHandlers.create>[0]),
    );

  users
    .command("open")
    .description("Open a user's dashboard page in your browser")
    .addArgument(createArgument("[user-id]", "User ID to open. Omit to pick interactively."))
    .option("--print", "Print the URL without opening the browser")
    .option("--secret-key <key>", "Backend API secret key to use")
    .option("--app <id>", "Application ID to target (works from any directory)")
    .option("--instance <id>", "Instance to target (dev, prod, or a full instance ID)")
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
      usersHandlers.open({
        ...(cmd.optsWithGlobals() as Parameters<typeof usersHandlers.open>[0]),
        userId,
      }),
    );

  const env = program
    .command("env")
    .description("Manage environment variables")
    .setExamples([
      { command: "clerk env pull", description: "Pull dev keys to .env.local" },
      { command: "clerk env pull --instance prod", description: "Pull production keys" },
      { command: "clerk env pull --file .env", description: "Write to a specific file" },
      { command: "clerk env pull --app app_abc123", description: "Target a specific application" },
    ]);

  env
    .command("pull")
    .description("Pull environment variables from Clerk to .env.local")
    .option("--app <id>", "Application ID to target (works from any directory)")
    .option("--instance <id>", "Instance to target (dev, prod, or a full instance ID)")
    .option("--file <path>", "Target env file (default: auto-detect)")
    .setExamples([
      { command: "clerk env pull", description: "Pull dev keys to .env.local" },
      { command: "clerk env pull --instance prod", description: "Pull production keys" },
      { command: "clerk env pull --file .env", description: "Write to a specific file" },
      { command: "clerk env pull --app app_abc123", description: "Target a specific application" },
    ])
    .action(pull);

  const config = program
    .command("config")
    .description("Manage instance configuration")
    .setExamples([
      { command: "clerk config pull", description: "Print dev config to stdout" },
      { command: "clerk config pull --instance prod", description: "Pull production config" },
      { command: "clerk config pull --output config.json", description: "Save config to a file" },
      { command: "clerk config schema", description: "Print full config schema" },
      {
        command: "clerk config schema --keys auth_email session",
        description: "Schema for specific top-level keys",
      },
      {
        command: "clerk config patch --file config.json",
        description: "Apply partial update from file",
      },
      {
        command: 'clerk config patch --json \'{"key":"value"}\'',
        description: "Inline JSON patch",
      },
      {
        command: "clerk config patch --file config.json --dry-run",
        description: "Preview without applying",
      },
      {
        command: "clerk config put --file config.json",
        description: "Replace entire config from file",
      },
      {
        command: "clerk config put --instance prod --file config.json",
        description: "Replace production config",
      },
    ]);

  config
    .command("pull")
    .description("Pull instance configuration from Clerk")
    .option("--app <id>", "Application ID to target (works from any directory)")
    .option("--instance <id>", "Instance to target (dev, prod, or a full instance ID)")
    .option("--output <file>", "Write config to a file instead of stdout")
    .option(
      "--keys <keys...>",
      "Top-level config keys to retrieve, separated by spaces or commas (e.g. auth_email session)",
    )
    .setExamples([
      { command: "clerk config pull", description: "Print dev config to stdout" },
      { command: "clerk config pull --instance prod", description: "Pull production config" },
      { command: "clerk config pull --output config.json", description: "Save config to a file" },
    ])
    .action(configPull);

  config
    .command("schema")
    .description("Pull instance config schema from Clerk")
    .option("--app <id>", "Application ID to target (works from any directory)")
    .option("--instance <id>", "Instance to target (dev, prod, or a full instance ID)")
    .option("--output <file>", "Write schema to a file instead of stdout")
    .option(
      "--keys <keys...>",
      "Top-level schema sections to retrieve, separated by spaces or commas (e.g. auth_email session)",
    )
    .setExamples([
      { command: "clerk config schema", description: "Print full config schema" },
      {
        command: "clerk config schema --keys auth_email session",
        description: "Schema for specific top-level keys",
      },
      { command: "clerk config schema --output schema.json", description: "Save schema to a file" },
    ])
    .action(configSchema);

  config
    .command("patch")
    .description("Partially update instance configuration (PATCH)")
    .option("--app <id>", "Application ID to target (works from any directory)")
    .option("--instance <id>", "Instance to target (dev, prod, or a full instance ID)")
    .option("--file <path>", "Read config JSON from a file")
    .option("--json <string>", "Pass config JSON inline")
    .option("--dry-run", "Show what would be sent without making the API call")
    .option("--yes", "Skip confirmation prompts")
    .option(
      "--destructive",
      "Allow destructive changes that delete resources (e.g. session templates, custom OAuth providers) rather than just resetting config to defaults",
    )
    .setExamples([
      {
        command: "clerk config patch --file config.json",
        description: "Apply partial update from file",
      },
      {
        command: 'clerk config patch --json \'{"key":"value"}\'',
        description: "Inline JSON patch",
      },
      {
        command: "clerk config patch --file config.json --dry-run",
        description: "Preview without applying",
      },
      {
        command: "clerk config patch --instance prod --file config.json",
        description: "Patch production config",
      },
    ])
    .action(configPatch);

  config
    .command("put")
    .description("Replace entire instance configuration (PUT)")
    .option("--app <id>", "Application ID to target (works from any directory)")
    .option("--instance <id>", "Instance to target (dev, prod, or a full instance ID)")
    .option("--file <path>", "Read config JSON from a file")
    .option("--json <string>", "Pass config JSON inline")
    .option("--dry-run", "Show what would be sent without making the API call")
    .option("--yes", "Skip confirmation prompts")
    .option(
      "--destructive",
      "Allow destructive changes that delete resources (e.g. session templates, custom OAuth providers) rather than just resetting config to defaults",
    )
    .setExamples([
      {
        command: "clerk config put --file config.json",
        description: "Replace entire config from file",
      },
      {
        command: "clerk config put --file config.json --dry-run",
        description: "Preview the replacement",
      },
      {
        command: "clerk config put --instance prod --file config.json",
        description: "Replace production config",
      },
      {
        command: "clerk config put --file config.json --yes",
        description: "Skip confirmation prompt",
      },
    ])
    .action(configPut);

  // --- clerk enable / disable ---
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

  program
    .command("api")
    .description("Make authenticated requests to the Clerk API")
    .argument(
      "[endpoint]",
      "API endpoint path, 'ls' to list endpoints, or omit for interactive mode",
    )
    .argument("[filter]", "Filter keyword (used with 'ls')")
    .option("-X, --method <method>", "HTTP method (default: GET, or POST if body provided)")
    .option("-d, --data <json>", "JSON request body")
    .option("--file <path>", "Read request body from a file")
    .option("--include", "Show response headers")
    .option("--app <id>", "Application ID to target when resolving keys")
    .option("--secret-key <key>", "Override the secret key")
    .option("--instance <id>", "Instance to target (dev, prod, or instance ID)")
    .option("--platform", "Use Platform API instead of Backend API")
    .option("--dry-run", "Show the request without executing it")
    .option("--yes", "Skip confirmation for mutating requests")
    .setExamples([
      { command: "clerk api ls", description: "List all available endpoints" },
      { command: "clerk api ls users", description: 'List endpoints matching "users"' },
      { command: "clerk api /users", description: "GET /v1/users" },
      {
        command: 'clerk api /users -d \'{"first_name":"Alice"}\'',
        description: "POST with a JSON body",
      },
    ])
    .action(api);

  program
    .command("doctor")
    .description("Check your project's Clerk integration health")
    .option("--verbose", "Show detailed output for each check")
    .option(
      "--json",
      "Output results as JSON. Each entry has fields: name, status (pass|warn|fail), message, detail, remedy",
    )
    .option("--spotlight", "Only show warnings and failures")
    .option("--fix", "Attempt to auto-fix issues")
    .setExamples([
      { command: "clerk doctor", description: "Run all health checks" },
      { command: "clerk doctor --verbose", description: "Show detailed output for each check" },
      { command: "clerk doctor --json", description: "Output results as machine-readable JSON" },
      { command: "clerk doctor --fix", description: "Auto-fix detected issues" },
      { command: "clerk doctor --spotlight", description: "Only show warnings and failures" },
    ])
    .action(doctor);

  program
    .command("switch-env", { hidden: true })
    .description("Switch the active Clerk CLI environment")
    .argument("[environment]", "Environment to switch to (e.g. production, staging)")
    .setExamples([
      { command: "clerk switch-env", description: "Show current environment" },
      { command: "clerk switch-env staging", description: "Switch to staging" },
      { command: "clerk switch-env production", description: "Switch back to production" },
    ])
    .action(switchEnv);

  program
    .command("completion")
    .description("Generate shell autocompletion script")
    .addArgument(
      createArgument("[shell]", `Shell type (${SUPPORTED_SHELLS.join(", ")})`).choices(
        SUPPORTED_SHELLS,
      ),
    )
    .setExamples([
      { command: "clerk completion bash", description: "Output bash completion script" },
      { command: "clerk completion zsh", description: "Output zsh completion script" },
      { command: "clerk completion fish", description: "Output fish completion script" },
      {
        command: "clerk completion powershell",
        description: "Output PowerShell completion script",
      },
    ])
    .addHelpText(
      "after",
      `
Tutorial — enable completions for your shell:

  Bash:
    $ eval "$(clerk completion bash)"                          # Current session only
    $ clerk completion bash > /etc/bash_completion.d/clerk     # Permanent (Linux)
    $ echo 'eval "$(clerk completion bash)"' >> ~/.bashrc      # Permanent (append)

  Zsh:
    $ eval "$(clerk completion zsh)"                           # Current session only
    $ mkdir -p ~/.zfunc && clerk completion zsh > ~/.zfunc/_clerk  # Permanent
    # Then add to ~/.zshrc: fpath=(~/.zfunc $fpath); autoload -Uz compinit && compinit

  Fish:
    $ mkdir -p ~/.config/fish/completions
    $ clerk completion fish > ~/.config/fish/completions/clerk.fish  # Auto-discovered

  PowerShell:
    $ clerk completion powershell | Out-String | Invoke-Expression  # Current session
    $ clerk completion powershell >> $PROFILE                       # Permanent`,
    )
    .action(completion);

  program
    .command("update")
    .description("Update the Clerk CLI to the latest version")
    .option("--channel <tag>", "Release channel to update to (e.g. latest, canary)")
    .option("-y, --yes", "Skip confirmation prompt")
    .option("--all", "Update every clerk install found on PATH, not just the first")
    .setExamples([
      { command: "clerk update", description: "Update to the latest stable release" },
      {
        command: "clerk update --channel canary",
        description: "Update to the latest canary release",
      },
      { command: "clerk update --yes", description: "Update without confirmation prompt" },
      { command: "clerk update --all", description: "Update every clerk install on PATH" },
    ])
    .action(update);

  const deployCmd = program
    .command("deploy")
    .description("Deploy a Clerk application to production");
  deployCmd.command("run", { isDefault: true, hidden: true }).action(deploy);
  deployCmd
    .command("status")
    .description("Show production deploy status (read-only)")
    .option("--wait", "Wait for DNS, SSL, and email DNS verification with retries")
    .action(deployStatus);

  registerExtras(program);

  return program;
}

export function formatApiBody(error: ApiError, verbose: boolean): string {
  if (verbose) {
    try {
      return "\n" + JSON.stringify(JSON.parse(error.body), null, 2);
    } catch {
      return "\n" + error.body;
    }
  }
  return formatStructuredError(error);
}

function formatStructuredError(error: ApiError): string {
  let msg = error.message;
  const { meta, code } = error;
  if (!meta) return msg;

  switch (code) {
    case "unsupported_subscription_plan_features": {
      const features = meta.unsupported_features;
      if (Array.isArray(features) && features.length > 0) {
        msg += `\n  Unsupported features: ${features.join(", ")}`;
      }
      break;
    }
    case "feature_not_enabled": {
      if (meta.param_name) {
        msg += `\n  Feature: ${meta.param_name}`;
      }
      break;
    }
    case "unknown_config_key": {
      const suggestions = meta.suggestions;
      if (Array.isArray(suggestions) && suggestions.length > 0) {
        msg += `\n  Did you mean: ${suggestions.join(", ")}`;
      }
      if (meta.param_name) {
        msg += `\n  Parameter: ${meta.param_name}`;
      }
      break;
    }
    default: {
      if (meta.param_name) {
        msg += `\n  Parameter: ${meta.param_name}`;
      }
      break;
    }
  }
  return msg;
}

type ParseFrom = "user" | "node";

/**
 * Resolve argv + `from` together so `--input-json` preprocessing always runs,
 * whether the caller passed explicit args (tests) or let it default to
 * `process.argv` (cli.ts entry point).
 */
async function resolveArgv(
  args: string[] | undefined,
  from: ParseFrom | undefined,
): Promise<{ argv: string[]; from: ParseFrom }> {
  const raw = args ?? process.argv;
  const effectiveFrom = from ?? (args === undefined ? "node" : "user");
  const argv = await expandInputJson([...raw]);
  return { argv, from: effectiveFrom };
}

/**
 * Parse and run a program, handling all typed errors with user-facing messages.
 * Used by `cli.ts` for real execution and by integration tests.
 */
export async function runProgram(
  program: ReturnType<typeof createProgram>,
  args?: string[],
  options?: { from: ParseFrom },
): Promise<void> {
  try {
    const { argv, from } = await resolveArgv(args, options?.from);
    await program.parseAsync(argv, { from });
  } catch (error) {
    const verbose = program.opts().verbose ?? false;

    if (error instanceof UserAbortError || isPromptExitError(error)) {
      process.exit(EXIT_CODE.SUCCESS);
    }

    if (error instanceof CliError) {
      if (isAgent() && error.code) {
        outputJsonError(error.code, error.message, error.docsUrl);
      } else {
        if (error.message) {
          log.error(error.message);
        }
        if (error.docsUrl) {
          log.info(`\nFor more information, see: ${error.docsUrl}`);
        }
      }
      process.exit(error.exitCode);
    }

    if (error instanceof ApiError) {
      const detail = formatApiBody(error, verbose);
      const prefix = error.context ?? "Request failed";
      if (isAgent()) {
        const apiErrors: ApiErrorEntry[] | undefined =
          error.code || error.meta
            ? [
                {
                  ...(error.code ? { code: error.code } : {}),
                  ...(error.message ? { message: error.message } : {}),
                  ...(error.meta ? { meta: error.meta } : {}),
                },
              ]
            : undefined;
        outputJsonError(
          error.code ?? "api_error",
          `${prefix} (${error.status}): ${detail}`,
          undefined,
          apiErrors,
        );
      } else {
        log.error(`${prefix} (${error.status}): ${detail}`);
        if (verbose && (error instanceof PlapiError || error instanceof FapiError) && error.url) {
          log.error(`       URL: ${error.url}`);
        }
        if (verbose && error.clerkTraceId) {
          log.error(`       Trace: ${error.clerkTraceId}`);
        }
      }
      process.exit(EXIT_CODE.GENERAL);
    }

    if (error instanceof Error) {
      if (isAgent()) {
        outputJsonError("unexpected_error", error.message);
      } else {
        log.error(error.message);
      }
      process.exit(EXIT_CODE.GENERAL);
    }

    if (isAgent()) {
      outputJsonError("unexpected_error", "An unexpected error occurred");
    } else {
      log.error("An unexpected error occurred");
    }
    process.exit(EXIT_CODE.GENERAL);
  }
}

interface ApiErrorEntry {
  code?: string;
  message?: string;
  meta?: Record<string, unknown>;
}

/** Output a structured JSON error to stderr for agent/CI consumption. */
function outputJsonError(
  code: string,
  message: string,
  docsUrl?: string,
  errors?: ApiErrorEntry[],
): void {
  const payload: {
    error: {
      code: string;
      message: string;
      docsUrl?: string;
      errors?: ApiErrorEntry[];
    };
  } = {
    error: { code, message },
  };
  if (docsUrl) payload.error.docsUrl = docsUrl;
  if (errors?.length) payload.error.errors = errors;
  log.raw(JSON.stringify(payload));
}
