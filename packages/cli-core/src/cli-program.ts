import { Command, createOption, createArgument } from "@commander-js/extra-typings";
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
import { doctor } from "./commands/doctor/index.ts";
import { switchEnv } from "./commands/switch-env/index.ts";
import { openDashboard } from "./commands/open/index.ts";
import { getEnvironment } from "./lib/config.ts";
import { setCurrentEnv, isValidEnv, getCurrentEnvName } from "./lib/environment.ts";
import { completion, SUPPORTED_SHELLS } from "./commands/completion/index.ts";
import { FRAMEWORK_NAMES } from "./lib/framework.ts";
import { PACKAGE_MANAGERS } from "./lib/package-manager.ts";
import { skillInstall } from "./commands/skill/install.ts";
import {
  CliError,
  UserAbortError,
  ApiError,
  PlapiError,
  EXIT_CODE,
  throwUsageError,
} from "./lib/errors.ts";
import { clerkHelpConfig } from "./lib/help.ts";
import { ExitPromptError } from "@inquirer/core";
import { isAgent } from "./mode.ts";
import { log } from "./lib/log.ts";
import { maybeNotifyUpdate, getCurrentVersion } from "./lib/update-check.ts";
import { update } from "./commands/update/index.ts";

export function createProgram() {
  const program = new Command()
    .name("clerk")
    .description("Clerk CLI")
    .configureHelp(clerkHelpConfig())
    .version(getCurrentVersion(), "-v, --version", "Output the version number")
    .helpOption("-h, --help", "Display help for command")
    .addHelpCommand("help [command]", "Display help for command")
    .option(
      "--mode <mode>",
      "Force interaction mode (human or agent). Defaults to auto-detect based on TTY.",
    )
    .option("--verbose", "Show detailed output (enables debug messages)");

  program.hook("preAction", async () => {
    // Reset log level at the start of each command invocation so a previous
    // --verbose or --debug flag doesn't leak into subsequent runs.
    setLogLevel("info");
    const opts = program.opts();
    if (opts.verbose) {
      setLogLevel("debug");
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
      setCurrentEnv(envName);
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
    .option("--prompt", "Output a prompt for an AI agent to integrate Clerk")
    .option("--starter", "Create a new project from a starter template")
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
      { command: "clerk init --prompt", description: "Output a setup prompt for an AI agent" },
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
    .setExamples([{ command: "clerk auth login", description: "Log in via browser (OAuth)" }])
    .action(async () => {
      await login();
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
    .action(async () => {
      await login();
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
    .description("Show the current logged-in user")
    .setExamples([{ command: "clerk whoami", description: "Show your email address" }])
    .action(whoami);

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
    .option("--json", "Output as JSON")
    .setExamples([
      { command: "clerk apps list", description: "List all applications" },
      { command: "clerk apps list --json", description: "Output as JSON" },
    ])
    .action(appsHandlers.list);

  apps
    .command("create")
    .description("Create a new Clerk application")
    .argument("<name>", "Application name")
    .option("--json", "Output as JSON")
    .setExamples([
      { command: 'clerk apps create "My App"', description: "Create a new application" },
      { command: 'clerk apps create "My App" --json', description: "Output as JSON" },
    ])
    .action(appsHandlers.create);

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
        command: "clerk config schema --keys social_login",
        description: "Schema for specific keys",
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
    .option("--keys <keys...>", "Config keys to retrieve")
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
    .option("--keys <keys...>", "Config keys to retrieve schema for")
    .setExamples([
      { command: "clerk config schema", description: "Print full config schema" },
      {
        command: "clerk config schema --keys social_login",
        description: "Schema for specific keys",
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
    .option("--json", "Output results as JSON")
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
    $ clerk completion fish > ~/.config/fish/completions/clerk.fish  # Auto-discovered

  PowerShell:
    $ clerk completion powershell | Out-String | Invoke-Expression  # Current session
    $ clerk completion powershell >> $PROFILE                       # Permanent`,
    )
    .action(completion);

  const skill = program
    .command("skill")
    .description("Manage the bundled Clerk CLI agent skill")
    .setExamples([
      { command: "clerk skill install", description: "Install the clerk-cli agent skill" },
      {
        command: "clerk skill install -y",
        description: "Install non-interactively (auto-detect agents, global scope)",
      },
    ]);

  skill
    .command("install")
    .description("Install the bundled clerk-cli agent skill")
    .option("-y, --yes", "Skip prompts and run the `skills` CLI unattended")
    .addOption(
      createOption("--pm <manager>", "Package manager hint for runner detection").choices(
        PACKAGE_MANAGERS,
      ),
    )
    .setExamples([
      { command: "clerk skill install", description: "Install with an interactive runner picker" },
      { command: "clerk skill install -y", description: "Install unattended" },
      {
        command: "clerk skill install --pm bun",
        description: "Force bunx as the runner",
      },
    ])
    .action(skillInstall);

  program
    .command("update")
    .description("Update the Clerk CLI to the latest version")
    .option("--channel <tag>", "Release channel to update to (e.g. latest, canary)")
    .option("-y, --yes", "Skip confirmation prompt")
    .setExamples([
      { command: "clerk update", description: "Update to the latest stable release" },
      {
        command: "clerk update --channel canary",
        description: "Update to the latest canary release",
      },
      { command: "clerk update --yes", description: "Update without confirmation prompt" },
    ])
    .action(update);

  return program;
}

export function formatApiBody(body: string, verbose: boolean): string {
  if (verbose) {
    try {
      return "\n" + JSON.stringify(JSON.parse(body), null, 2);
    } catch {
      return "\n" + body;
    }
  }

  try {
    const parsed = JSON.parse(body);
    if (Array.isArray(parsed.errors) && parsed.errors.length > 0) {
      return parsed.errors.map(formatSingleError).join("\n");
    }
    if (parsed.error) return parsed.error;
    if (parsed.message) return parsed.message;
  } catch {
    // not JSON
  }

  if (body.length > 200) return body.slice(0, 200) + "...";
  return body;
}

function formatSingleError(err: {
  message?: string;
  code?: string;
  meta?: Record<string, unknown>;
}): string {
  let msg = err.message ?? "Unknown error";
  const meta = err.meta;
  if (!meta) return msg;

  switch (err.code) {
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

/**
 * Parse and run a program, handling all typed errors with user-facing messages.
 * Used by `cli.ts` for real execution and by integration tests.
 */
export async function runProgram(
  program: ReturnType<typeof createProgram>,
  args?: string[],
  options?: { from: "user" | "node" },
): Promise<void> {
  try {
    await program.parseAsync(args, options);
  } catch (error) {
    const verbose = program.opts().verbose ?? false;

    if (error instanceof UserAbortError || error instanceof ExitPromptError) {
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
      const detail = formatApiBody(error.body, verbose);
      const prefix = error.context ?? "Request failed";
      if (isAgent()) {
        const apiCode = extractApiErrorCode(error.body);
        const apiErrors = extractApiErrors(error.body);
        outputJsonError(
          apiCode ?? "api_error",
          `${prefix} (${error.status}): ${detail}`,
          undefined,
          apiErrors,
        );
      } else {
        log.error(`${prefix} (${error.status}): ${detail}`);
        if (verbose && error instanceof PlapiError && error.url) {
          log.error(`       URL: ${error.url}`);
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

/** Extract the error code from a Clerk API JSON response body, if present. */
function extractApiErrorCode(body: string): string | undefined {
  try {
    const parsed = JSON.parse(body);
    return parsed.errors?.[0]?.code;
  } catch {
    return undefined;
  }
}

/** Extract the full errors array from a Clerk API JSON response body, if present. */
function extractApiErrors(body: string): ApiErrorEntry[] | undefined {
  try {
    const parsed = JSON.parse(body);
    if (Array.isArray(parsed.errors) && parsed.errors.length > 0) {
      return parsed.errors.map((e: ApiErrorEntry) => {
        const entry: ApiErrorEntry = {};
        if (e.code) entry.code = e.code;
        if (e.message) entry.message = e.message;
        if (e.meta && Object.keys(e.meta).length > 0) entry.meta = e.meta;
        return entry;
      });
    }
  } catch {
    // not JSON
  }
  return undefined;
}
