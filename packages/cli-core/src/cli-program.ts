import { Command } from "@commander-js/extra-typings";
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
import { doctor } from "./commands/doctor/index.ts";
import { CliError, UserAbortError, ApiError, EXIT_CODE, throwUsageError } from "./lib/errors.ts";
import { red } from "./lib/color.ts";

async function getDevVersion(): Promise<string> {
  try {
    const pkg = await Bun.file(`${import.meta.dir}/../../cli/package.json`).json();
    return `${pkg.version}-dev`;
  } catch {
    return "0.0.0-dev";
  }
}

export async function createProgram() {
  const program = new Command()
    .name("clerk")
    .description("Clerk CLI")
    .version(typeof CLI_VERSION !== "undefined" ? CLI_VERSION : await getDevVersion())
    .option(
      "--mode <mode>",
      "Force interaction mode (human or agent). Defaults to auto-detect based on TTY.",
    )
    .option("--verbose", "Show detailed error output");

  program.hook("preAction", () => {
    const opts = program.opts();
    if (opts.mode) {
      if (opts.mode !== "human" && opts.mode !== "agent") {
        throwUsageError(`Invalid mode "${opts.mode}". Must be "human" or "agent".`);
      }
      setMode(opts.mode as Mode);
    }
  });

  program.command("init").description("Initialize Clerk in your project").action(init);

  const auth = program.command("auth").description("Manage authentication");

  auth
    .command("login")
    .aliases(["signup", "signin", "sign-in"])
    .description("Log in to your Clerk account")
    .action(async () => {
      await login();
    });

  auth
    .command("logout")
    .aliases(["signout", "sign-out"])
    .description("Log out of your Clerk account")
    .action(logout);

  program
    .command("link")
    .description("Link this project to a Clerk application")
    .option("--app <id>", "Application ID to link (skips interactive picker)")
    .action(link);

  program
    .command("unlink")
    .description("Unlink this project from its Clerk application")
    .option("--yes", "Skip confirmation prompt")
    .action(unlink);

  program.command("whoami").description("Show the current logged-in user").action(whoami);

  const env = program.command("env").description("Manage environment variables");

  env
    .command("pull")
    .description("Pull environment variables from Clerk to .env.local")
    .option("--instance <id>", "Instance to target (dev, prod, or a full instance ID)")
    .option("--file <path>", "Target env file (default: auto-detect)")
    .action(pull);

  const config = program.command("config").description("Manage instance configuration");

  config
    .command("pull")
    .description("Pull instance configuration from Clerk")
    .option("--instance <id>", "Instance to target (dev, prod, or a full instance ID)")
    .option("--output <file>", "Write config to a file instead of stdout")
    .action(configPull);

  config
    .command("schema")
    .description("Pull instance config schema from Clerk")
    .option("--instance <id>", "Instance to target (dev, prod, or a full instance ID)")
    .option("--output <file>", "Write schema to a file instead of stdout")
    .option("--keys <keys...>", "Config keys to retrieve schema for")
    .action(configSchema);

  config
    .command("patch")
    .description("Partially update instance configuration (PATCH)")
    .option("--instance <id>", "Instance to target (dev, prod, or a full instance ID)")
    .option("--file <path>", "Read config JSON from a file")
    .option("--json <string>", "Pass config JSON inline")
    .option("--dry-run", "Show what would be sent without making the API call")
    .option("--yes", "Skip confirmation prompts")
    .action(configPatch);

  config
    .command("put")
    .description("Replace entire instance configuration (PUT)")
    .option("--instance <id>", "Instance to target (dev, prod, or a full instance ID)")
    .option("--file <path>", "Read config JSON from a file")
    .option("--json <string>", "Pass config JSON inline")
    .option("--dry-run", "Show what would be sent without making the API call")
    .option("--yes", "Skip confirmation prompts")
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
    .action(doctor);

  program
    .command("deploy", { hidden: true })
    .description("Deploy your Clerk application")
    .option("--debug", "Show debug output")
    .action(deploy);

  return program;
}

function formatApiBody(body: string, verbose: boolean): string {
  if (verbose) {
    try {
      return "\n" + JSON.stringify(JSON.parse(body), null, 2);
    } catch {
      return "\n" + body;
    }
  }

  try {
    const parsed = JSON.parse(body);
    if (parsed.errors?.[0]?.message) return parsed.errors[0].message;
    if (parsed.error) return parsed.error;
    if (parsed.message) return parsed.message;
  } catch {
    // not JSON
  }

  if (body.length > 200) return body.slice(0, 200) + "...";
  return body;
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

    if (error instanceof UserAbortError) {
      process.exit(EXIT_CODE.SUCCESS);
    }

    if (error instanceof CliError) {
      if (error.message) {
        console.error(red(`error: ${error.message}`));
      }
      if (error.docsUrl) {
        console.error(`\nFor more information, see: ${error.docsUrl}`);
      }
      process.exit(error.exitCode);
    }

    if (error instanceof ApiError) {
      const detail = formatApiBody(error.body, verbose);
      const prefix = error.context ?? "Request failed";
      console.error(red(`error: ${prefix} (${error.status}): ${detail}`));
      process.exit(EXIT_CODE.GENERAL);
    }

    if (error instanceof Error) {
      console.error(red(`error: ${error.message}`));
      process.exit(EXIT_CODE.GENERAL);
    }

    console.error(red("error: An unexpected error occurred"));
    process.exit(EXIT_CODE.GENERAL);
  }
}
