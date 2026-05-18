import { Command } from "@commander-js/extra-typings";
import { expandInputJson } from "./lib/input-json.ts";
import { setLogLevel } from "./lib/log.ts";
import { setColorEnabled } from "./lib/color.ts";
import { setMode, type Mode } from "./mode.ts";
import { registerInit } from "./commands/init/index.ts";
import { registerAuth } from "./commands/auth/index.ts";
import { registerLink } from "./commands/link/index.ts";
import { registerUnlink } from "./commands/unlink/index.ts";
import { registerWhoami } from "./commands/whoami/index.ts";
import { registerOpen } from "./commands/open/index.ts";
import { registerApps } from "./commands/apps/index.ts";
import { registerUsers } from "./commands/users/index.ts";
import { registerEnv } from "./commands/env/index.ts";
import { registerConfig } from "./commands/config/index.ts";
import { registerToggles } from "./commands/toggles/index.ts";
import { registerApi } from "./commands/api/index.ts";
import { registerDoctor } from "./commands/doctor/index.ts";
import { registerSwitchEnv } from "./commands/switch-env/index.ts";
import { registerCompletion } from "./commands/completion/index.ts";
import { registerUpdate } from "./commands/update/index.ts";
import { registerDeploy } from "./commands/deploy/index.ts";
import { getEnvironment } from "./lib/config.ts";
import {
  setCurrentEnv,
  isValidEnv,
  getCurrentEnvName,
  getAvailableEnvs,
  getPlapiBaseUrl,
} from "./lib/environment.ts";
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
import { registerExtras } from "@clerk/cli-extras";

/**
 * The root `clerk` program with its global options applied, so registrants
 * can rely on the typed global option contract instead of a generic Command.
 */
export type Program = Command<[], { inputJson?: string; mode?: string; verbose?: boolean }>;

type CommandRegistrant = (program: Program) => void;

const registrants: CommandRegistrant[] = [
  registerInit,
  registerAuth,
  registerLink,
  registerUnlink,
  registerWhoami,
  registerOpen,
  registerApps,
  registerUsers,
  registerEnv,
  registerConfig,
  registerToggles,
  registerApi,
  registerDoctor,
  registerSwitchEnv,
  registerCompletion,
  registerUpdate,
  registerDeploy,
  registerExtras,
];

export function createProgram(): Program {
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
    .option("--no-color", "Disable ANSI color output (also respects the NO_COLOR env var)")
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
    ) as Program;

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
    // Commander's negation maps `--no-color` to `opts.color === false`.
    if (opts.color === false) {
      setColorEnabled(false);
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

  for (const register of registrants) {
    register(program);
  }

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
