import { Command, createOption, createArgument } from "@commander-js/extra-typings";
import { setMode, type Mode } from "./mode.ts";
import { init } from "./commands/init/index.ts";
import { login } from "./commands/auth/login.ts";
import { logout } from "./commands/auth/logout.ts";
import { whoami } from "./commands/whoami/index.ts";
import { pull } from "./commands/env/pull.ts";
import { deploy } from "./commands/deploy/index.ts";
import { configPull } from "./commands/config/pull.ts";
import { configPatch, configPut } from "./commands/config/push.ts";
import { configSchema } from "./commands/config/schema.ts";
import { api } from "./commands/api/index.ts";
import { link } from "./commands/link/index.ts";
import { unlink } from "./commands/unlink/index.ts";
import { list as appsList } from "./commands/apps/list.ts";
import { doctor } from "./commands/doctor/index.ts";
import { switchEnv } from "./commands/switch-env/index.ts";
import { getEnvironment } from "./lib/config.ts";
import { setCurrentEnv, isValidEnv, getCurrentEnvName } from "./lib/environment.ts";
import { completion, SUPPORTED_SHELLS } from "./commands/completion/index.ts";
import { FRAMEWORK_NAMES } from "./lib/framework.ts";
import { CliError, UserAbortError, ApiError, EXIT_CODE, throwUsageError } from "./lib/errors.ts";
import { clerkHelpConfig } from "./lib/help.ts";
import { ExitPromptError } from "@inquirer/core";
import { red } from "./lib/color.ts";
import { isAgent } from "./mode.ts";

export function createProgram() {
  const program = new Command()
    .name("clerk")
    .description("Clerk CLI")
    .configureHelp(clerkHelpConfig())
    .version(
      typeof CLI_VERSION !== "undefined" ? CLI_VERSION : "0.0.0-dev",
      "-v, --version",
      "Output the version number",
    )
    .helpOption("-h, --help", "Display help for command")
    .addHelpCommand("help [command]", "Display help for command")
    .option(
      "--mode <mode>",
      "Force interaction mode (human or agent). Defaults to auto-detect based on TTY.",
    )
    .option("--verbose", "Show detailed error output");

  program.hook("preAction", async () => {
    const opts = program.opts();
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

  program
    .command("init")
    .description("Initialize Clerk in your project")
    .addOption(
      createOption("--framework <name>", "Framework to set up (skips auto-detection)").choices(
        FRAMEWORK_NAMES,
      ),
    )
    .option("--prompt", "Output a prompt for an AI agent to integrate Clerk")
    .option("-y, --yes", "Skip confirmation prompts")
    .addHelpText(
      "after",
      `
Examples:
  $ clerk init                       Auto-detect framework and set up Clerk
  $ clerk init --framework next      Set up for Next.js (skips detection)
  $ clerk init --prompt              Output a setup prompt for an AI agent
  $ clerk init -y                    Skip all confirmation prompts`,
    )
    .action(init);

  const auth = program
    .command("auth")
    .description("Manage authentication")
    .addHelpText(
      "after",
      `
Examples:
  $ clerk auth login                 Log in via browser (OAuth)
  $ clerk auth logout                Remove stored credentials`,
    );

  auth
    .command("login")
    .aliases(["signup", "signin", "sign-in"])
    .description("Log in to your Clerk account")
    .addHelpText(
      "after",
      `
Examples:
  $ clerk auth login                 Log in via browser (OAuth)`,
    )
    .action(async () => {
      await login();
    });

  auth
    .command("logout")
    .aliases(["signout", "sign-out"])
    .description("Log out of your Clerk account")
    .addHelpText(
      "after",
      `
Examples:
  $ clerk auth logout                Remove stored credentials`,
    )
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
    .addHelpText(
      "after",
      `
Examples:
  $ clerk link                       Pick an app interactively
  $ clerk link --app app_abc123      Link directly by application ID`,
    )
    .action(link);

  program
    .command("unlink")
    .description("Unlink this project from its Clerk application")
    .option("--yes", "Skip confirmation prompt")
    .addHelpText(
      "after",
      `
Examples:
  $ clerk unlink                     Unlink with confirmation prompt
  $ clerk unlink --yes               Skip confirmation`,
    )
    .action(unlink);

  program
    .command("whoami")
    .description("Show the current logged-in user")
    .addHelpText(
      "after",
      `
Examples:
  $ clerk whoami                     Show your email address`,
    )
    .action(whoami);

  const apps = program.command("apps").description("Manage your Clerk applications");

  apps
    .command("list")
    .description("List your Clerk applications")
    .option("--json", "Output as JSON")
    .addHelpText(
      "after",
      `
Examples:
  $ clerk apps list                    List all applications
  $ clerk apps list --json             Output as JSON`,
    )
    .action(appsList);

  const env = program
    .command("env")
    .description("Manage environment variables")
    .addHelpText(
      "after",
      `
Examples:
  $ clerk env pull                             Pull dev keys to .env.local
  $ clerk env pull --instance prod             Pull production keys
  $ clerk env pull --file .env                 Write to a specific file
  $ clerk env pull --app app_abc123            Target a specific application`,
    );

  env
    .command("pull")
    .description("Pull environment variables from Clerk to .env.local")
    .option("--app <id>", "Application ID to target (works from any directory)")
    .option("--instance <id>", "Instance to target (dev, prod, or a full instance ID)")
    .option("--file <path>", "Target env file (default: auto-detect)")
    .addHelpText(
      "after",
      `
Examples:
  $ clerk env pull                             Pull dev keys to .env.local
  $ clerk env pull --instance prod             Pull production keys
  $ clerk env pull --file .env                 Write to a specific file
  $ clerk env pull --app app_abc123            Target a specific application`,
    )
    .action(pull);

  const config = program
    .command("config")
    .description("Manage instance configuration")
    .addHelpText(
      "after",
      `
Examples:
  $ clerk config pull                                      Print dev config to stdout
  $ clerk config pull --instance prod                      Pull production config
  $ clerk config pull --output config.json                 Save config to a file
  $ clerk config schema                                    Print full config schema
  $ clerk config schema --keys social_login                Schema for specific keys
  $ clerk config patch --file config.json                  Apply partial update from file
  $ clerk config patch --json '{"key":"value"}'            Inline JSON patch
  $ clerk config patch --file config.json --dry-run        Preview without applying
  $ clerk config put --file config.json                    Replace entire config from file
  $ clerk config put --instance prod --file config.json    Replace production config`,
    );

  config
    .command("pull")
    .description("Pull instance configuration from Clerk")
    .option("--app <id>", "Application ID to target (works from any directory)")
    .option("--instance <id>", "Instance to target (dev, prod, or a full instance ID)")
    .option("--output <file>", "Write config to a file instead of stdout")
    .option("--keys <keys...>", "Config keys to retrieve")
    .addHelpText(
      "after",
      `
Examples:
  $ clerk config pull                          Print dev config to stdout
  $ clerk config pull --instance prod          Pull production config
  $ clerk config pull --output config.json     Save config to a file`,
    )
    .action(configPull);

  config
    .command("schema")
    .description("Pull instance config schema from Clerk")
    .option("--app <id>", "Application ID to target (works from any directory)")
    .option("--instance <id>", "Instance to target (dev, prod, or a full instance ID)")
    .option("--output <file>", "Write schema to a file instead of stdout")
    .option("--keys <keys...>", "Config keys to retrieve schema for")
    .addHelpText(
      "after",
      `
Examples:
  $ clerk config schema                          Print full config schema
  $ clerk config schema --keys social_login      Schema for specific keys
  $ clerk config schema --output schema.json     Save schema to a file`,
    )
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
    .addHelpText(
      "after",
      `
Examples:
  $ clerk config patch --file config.json                Apply partial update from file
  $ clerk config patch --json '{"key":"value"}'          Inline JSON patch
  $ clerk config patch --file config.json --dry-run      Preview without applying
  $ clerk config patch --instance prod --file config.json  Patch production config`,
    )
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
    .addHelpText(
      "after",
      `
Examples:
  $ clerk config put --file config.json                  Replace entire config from file
  $ clerk config put --file config.json --dry-run        Preview the replacement
  $ clerk config put --instance prod --file config.json  Replace production config
  $ clerk config put --file config.json --yes            Skip confirmation prompt`,
    )
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
    .addHelpText(
      "after",
      `
Examples:
  $ clerk api ls                                   List all available endpoints
  $ clerk api ls users                             List endpoints matching "users"
  $ clerk api /users                               GET /v1/users
  $ clerk api /users -d '{"first_name":"Alice"}'   POST with a JSON body`,
    )
    .action(api);

  program
    .command("doctor")
    .description("Check your project's Clerk integration health")
    .option("--verbose", "Show detailed output for each check")
    .option("--json", "Output results as JSON")
    .option("--spotlight", "Only show warnings and failures")
    .option("--fix", "Attempt to auto-fix issues")
    .addHelpText(
      "after",
      `
Examples:
  $ clerk doctor                     Run all health checks
  $ clerk doctor --verbose           Show detailed output for each check
  $ clerk doctor --json              Output results as machine-readable JSON
  $ clerk doctor --fix               Auto-fix detected issues
  $ clerk doctor --spotlight         Only show warnings and failures`,
    )
    .action(doctor);

  program
    .command("switch-env")
    .description("Switch the active Clerk CLI environment")
    .argument("[environment]", "Environment to switch to (e.g. production, staging)")
    .addHelpText(
      "after",
      `
Examples:
  $ clerk switch-env                   Show current environment
  $ clerk switch-env staging           Switch to staging
  $ clerk switch-env production        Switch back to production`,
    )
    .action(switchEnv);

  program
    .command("completion")
    .description("Generate shell autocompletion script")
    .addArgument(
      createArgument("[shell]", `Shell type (${SUPPORTED_SHELLS.join(", ")})`).choices(
        SUPPORTED_SHELLS,
      ),
    )
    .addHelpText(
      "after",
      `
Examples:
  $ clerk completion bash              Output bash completion script
  $ clerk completion zsh               Output zsh completion script
  $ clerk completion fish              Output fish completion script
  $ clerk completion powershell        Output PowerShell completion script

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

  program
    .command("deploy", { hidden: true })
    .description("Deploy your Clerk application")
    .option("--debug", "Show debug output")
    .action(deploy);

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
          console.error(red(`error: ${error.message}`));
        }
        if (error.docsUrl) {
          console.error(`\nFor more information, see: ${error.docsUrl}`);
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
        console.error(red(`error: ${prefix} (${error.status}): ${detail}`));
      }
      process.exit(EXIT_CODE.GENERAL);
    }

    if (error instanceof Error) {
      if (isAgent()) {
        outputJsonError("unexpected_error", error.message);
      } else {
        console.error(red(`error: ${error.message}`));
      }
      process.exit(EXIT_CODE.GENERAL);
    }

    if (isAgent()) {
      outputJsonError("unexpected_error", "An unexpected error occurred");
    } else {
      console.error(red("error: An unexpected error occurred"));
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
  console.error(JSON.stringify(payload));
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
