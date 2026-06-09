import { Command } from "@commander-js/extra-typings";
import { expandInputJson } from "./lib/input-json.ts";
import { setLogLevel } from "./lib/log.ts";
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
import { getAuthToken } from "./lib/plapi.ts";
import { webhooks as webhooksHandlers } from "./commands/webhooks/index.ts";
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
    .option("--verbose", "Show detailed output (enables debug messages)") as Program;

  program.hook("preAction", async () => {
    // Reset log level at the start of each command invocation so a previous
    // --verbose doesn't leak into subsequent runs.
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

  const webhooks = program
    .command("webhooks")
    .description("Manage webhook endpoints and deliveries")
    .option("--app <id>", "Application ID to target (works from any directory)")
    .option("--instance <id>", "Instance to target (dev, prod, or a full instance ID)")
    .option("--json", "Output as JSON")
    .setExamples([
      { command: "clerk webhooks list", description: "List webhook endpoints" },
      {
        command: "clerk webhooks create --url https://example.com/api/webhooks",
        description: "Create an endpoint and print its signing secret",
      },
      {
        command: "clerk webhooks listen --forward-to http://localhost:3000/api/webhooks",
        description: "Forward instance events to a local handler",
      },
    ]);

  webhooks.hook("preAction", async (_thisCommand, actionCommand) => {
    if (actionCommand.name() === "verify") return; // pure offline HMAC, no auth gate
    await getAuthToken();
  });

  webhooks
    .command("list")
    .description("List webhook endpoints for the instance")
    .option("--limit <number>", "Maximum endpoints to return (1-250, default 100)", (value) =>
      parseIntegerOption(value, "--limit", { min: 1, max: 250 }),
    )
    .option("--iterator <cursor>", "Pagination cursor from the previous response")
    .setExamples([
      { command: "clerk webhooks list", description: "List webhook endpoints" },
      { command: "clerk webhooks list --limit 10", description: "List the first 10 endpoints" },
      {
        command: "clerk webhooks list --iterator iter_abc",
        description: "Fetch the next page using a previous response's cursor",
      },
    ])
    .action((_opts, cmd) =>
      webhooksHandlers.list(cmd.optsWithGlobals() as Parameters<typeof webhooksHandlers.list>[0]),
    );

  webhooks
    .command("get")
    .description("Show one webhook endpoint's configuration")
    .argument("<id>", "Webhook endpoint ID (ep_...)")
    .setExamples([
      { command: "clerk webhooks get ep_2abc123", description: "Show an endpoint's config" },
      {
        command: "clerk webhooks get ep_2abc123 --json",
        description: "Emit the endpoint resource as JSON",
      },
    ])
    .action((endpointId, _opts, cmd) =>
      webhooksHandlers.get({
        ...(cmd.optsWithGlobals() as Omit<
          Parameters<typeof webhooksHandlers.get>[0],
          "endpointId"
        >),
        endpointId,
      }),
    );
: add 'webhooks get' command)

  webhooks
    .command("event-types")
    .description("List the instance's webhook event-type catalog")
    .option("--limit <number>", "Maximum event types to return (1-250, default 100)", (value) =>
      parseIntegerOption(value, "--limit", { min: 1, max: 250 }),
    )
    .option("--iterator <cursor>", "Pagination cursor from the previous response")
    .setExamples([
      { command: "clerk webhooks event-types", description: "List available event types" },
      {
        command: "clerk webhooks event-types --json",
        description: "Emit the catalog as JSON",
      },
    ])
    .action((_opts, cmd) =>
      webhooksHandlers.eventTypes(
        cmd.optsWithGlobals() as Parameters<typeof webhooksHandlers.eventTypes>[0],
      ),
    );
: add 'webhooks event-types' command)

  webhooks
    .command("secret")
    .description("Print a webhook endpoint's signing secret")
    .argument("<id>", "Webhook endpoint ID (ep_...)")
    .option(
      "--rotate",
      "Rotate the signing secret first. The old key keeps verifying for 24h (Svix dual-signing grace).",
    )
    .option("--yes", "Skip the rotation confirmation prompt (required with --rotate in agent mode)")
    .setExamples([
      { command: "clerk webhooks secret ep_2abc123", description: "Print the signing secret" },
      {
        command: "export CLERK_WEBHOOK_SIGNING_SECRET=$(clerk webhooks secret ep_2abc123)",
        description: "Export the secret into the environment",
      },
      {
        command: "clerk webhooks secret ep_2abc123 --rotate",
        description: "Rotate, then print the new secret",
      },
    ])
    .action((endpointId, _opts, cmd) =>
      webhooksHandlers.secret({
        ...(cmd.optsWithGlobals() as Omit<
          Parameters<typeof webhooksHandlers.secret>[0],
          "endpointId"
        >),
        endpointId,
      }),
    );
: add 'webhooks secret' command with --rotate)

  webhooks
    .command("delete")
    .description("Delete a webhook endpoint")
    .argument("<id>", "Webhook endpoint ID (ep_...)")
    .option("--yes", "Skip the confirmation prompt (required in agent mode)")
    .setExamples([
      { command: "clerk webhooks delete ep_2abc123", description: "Delete with confirmation" },
      {
        command: "clerk webhooks delete ep_2abc123 --yes",
        description: "Delete without prompting",
      },
    ])
    .action((endpointId, _opts, cmd) =>
      webhooksHandlers.delete({
        ...(cmd.optsWithGlobals() as Omit<
          Parameters<typeof webhooksHandlers.delete>[0],
          "endpointId"
        >),
        endpointId,
      }),
    );
: add 'webhooks delete' command)

  webhooks
    .command("update")
    .description("Update a webhook endpoint's configuration")
    .argument("<id>", "Webhook endpoint ID (ep_...)")
    .option("--url <url>", "New destination URL")
    .option(
      "--events <types>",
      "Comma-separated event types to filter on (e.g. user.created,user.deleted)",
    )
    .option("--description <text>", "New description")
    .option("--channels <channels>", "Comma-separated channels")
    .option("--enable", "Re-enable a disabled endpoint")
    .option("--disable", "Disable the endpoint")
    .setExamples([
      {
        command: "clerk webhooks update ep_2abc123 --url https://example.com/api/webhooks",
        description: "Point the endpoint at a new URL",
      },
      {
        command: "clerk webhooks update ep_2abc123 --events user.created,user.deleted",
        description: "Replace the event-type filter",
      },
      {
        command: "clerk webhooks update ep_2abc123 --enable",
        description: "Re-enable an endpoint",
      },
    ])
    .action((endpointId, _opts, cmd) =>
      webhooksHandlers.update({
        ...(cmd.optsWithGlobals() as Omit<
          Parameters<typeof webhooksHandlers.update>[0],
          "endpointId"
        >),
        endpointId,
      }),
    );
: add 'webhooks update' command)

  webhooks
    .command("create")
    .description("Create a webhook endpoint and print its signing secret")
    .option("--url <url>", "Destination URL (required)")
    .option(
      "--events <types>",
      "Comma-separated event types to filter on (e.g. user.created,user.deleted)",
    )
    .option("--description <text>", "Endpoint description")
    .option("--channels <channels>", "Comma-separated channels")
    .option("--disabled", "Create the endpoint in a disabled state")
    .setExamples([
      {
        command: "clerk webhooks create --url https://example.com/api/webhooks",
        description: "Create an endpoint receiving all events",
      },
      {
        command:
          "clerk webhooks create --url https://example.com/api/webhooks --events user.created,user.deleted",
        description: "Create an endpoint filtered to specific events",
      },
      {
        command: "clerk webhooks create --url https://example.com/api/webhooks --disabled",
        description: "Create the endpoint disabled",
      },
    ])
    .action((_opts, cmd) =>
      webhooksHandlers.create(
        cmd.optsWithGlobals() as Parameters<typeof webhooksHandlers.create>[0],
      ),
    );
: add 'webhooks create' command)

  webhooks
    .command("messages")
    .description("List recent deliveries for an endpoint (the feed for `webhooks replay`)")
    .option(
      "--endpoint <ep_id>",
      "Endpoint to inspect (defaults to this instance's relay endpoint from `webhooks listen`)",
    )
    .addOption(
      createOption("--status <status>", "Filter by delivery status").choices([
        "success",
        "pending",
        "fail",
        "sending",
      ]),
    )
    .option("--limit <number>", "Maximum deliveries to return (1-250, default 100)", (value) =>
      parseIntegerOption(value, "--limit", { min: 1, max: 250 }),
    )
    .option("--iterator <cursor>", "Pagination cursor from the previous response")
    .setExamples([
      {
        command: "clerk webhooks messages --endpoint ep_2abc123",
        description: "List recent deliveries for an endpoint",
      },
      {
        command: "clerk webhooks messages --status fail",
        description: "List failed deliveries on the relay endpoint",
      },
    ])
    .action((_opts, cmd) =>
      webhooksHandlers.messages(
        cmd.optsWithGlobals() as Parameters<typeof webhooksHandlers.messages>[0],
      ),
    );
: add 'webhooks messages' command)

  webhooks
    .command("replay")
    .description("Resend one delivery, or bulk-recover a time window of deliveries")
    .argument("[msg_id]", "Message ID to resend (mutually exclusive with --since)")
    .option(
      "--endpoint <ep_id>",
      "Target endpoint (defaults to the relay endpoint for <msg_id>; required with --since)",
    )
    .option("--since <ISO>", "Bulk-recover deliveries from this RFC 3339 timestamp")
    .option("--until <ISO>", "Optional end of the recovery window (requires --since)")
    .option("--yes", "Skip the bulk-recovery confirmation prompt (required in agent mode)")
    .setExamples([
      {
        command: "clerk webhooks replay msg_2xyz",
        description: "Resend one delivery to the relay endpoint",
      },
      {
        command: "clerk webhooks replay msg_2xyz --endpoint ep_2abc123",
        description: "Resend one delivery to a specific endpoint",
      },
      {
        command:
          "clerk webhooks replay --since 2026-05-01T00:00:00Z --until 2026-05-01T01:00:00Z --endpoint ep_2abc123",
        description: "Recover all deliveries in a bounded window",
      },
    ])
    .action((msgId, _opts, cmd) =>
      webhooksHandlers.replay({
        ...(cmd.optsWithGlobals() as Omit<Parameters<typeof webhooksHandlers.replay>[0], "msgId">),
        msgId,
      }),
    );
: add 'webhooks replay' command)

  webhooks
    .command("trigger")
    .description("Send an example event to an endpoint (validates the type first)")
    .argument("<event_type>", "Event type to trigger (e.g. user.created)")
    .option(
      "--endpoint <ep_id>",
      "Target endpoint (defaults to this instance's relay endpoint from `webhooks listen`)",
    )
    .setExamples([
      {
        command: "clerk webhooks trigger user.created",
        description: "Send an example user.created event to the relay endpoint",
      },
      {
        command: "clerk webhooks trigger user.created --endpoint ep_2abc123",
        description: "Send an example event to a specific endpoint",
      },
    ])
    .action((eventType, _opts, cmd) =>
      webhooksHandlers.trigger({
        ...(cmd.optsWithGlobals() as Omit<
          Parameters<typeof webhooksHandlers.trigger>[0],
          "eventType"
        >),
        eventType,
      }),
    );
: add 'webhooks trigger' command)

  webhooks
    .command("open")
    .description("Open the instance's webhook portal in your browser")
    .setExamples([
      { command: "clerk webhooks open", description: "Open the webhook portal" },
      { command: "clerk webhooks open --json", description: "Print the portal URL as JSON" },
    ])
    .action((_opts, cmd) =>
      webhooksHandlers.open(cmd.optsWithGlobals() as Parameters<typeof webhooksHandlers.open>[0]),
    );
: add 'webhooks open' command)
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
