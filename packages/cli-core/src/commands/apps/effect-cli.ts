import { BunServices } from "@effect/platform-bun";
import { Console, Effect, Exit, Layer, Option } from "effect";
import {
  Command,
  Flag,
  CliConfig,
  CliOutput,
  GlobalFlag,
  CliError as EffectCliError,
} from "effect/cli";
import { initializeEnvironment, initializeGlobalMode } from "../../cli-program.ts";
import { CliError, EXIT_CODE } from "../../lib/errors.ts";
import { log } from "../../lib/log.ts";
import { startCommandTelemetry, type TelemetryCommand } from "../../lib/telemetry.ts";
import { maybeNotifyUpdate } from "../../lib/update-check.ts";
import { CURRENT_VERSION } from "../../lib/version.ts";
import { AppsFailure, isAppsFailure, listEffect } from "./list-effect.ts";
import { AppsConfiguration, appsListLayer } from "./list-services.ts";

const root = Command.make("clerk").pipe(
  Command.withSharedFlags({
    mode: Flag.String("mode").pipe(Flag.optional),
    verbose: Flag.Boolean("verbose").pipe(Flag.withDefault(false)),
  }),
);
const listCommand = Command.make(
  "list",
  { json: Flag.Boolean("json").pipe(Flag.withDefault(false)) },
  Effect.fn("apps.list.command")(function* (options) {
    const globals = yield* root;
    const mode = Option.getOrUndefined(globals.mode);
    const flags = [
      options.json ? "json" : undefined,
      globals.verbose ? "verbose" : undefined,
      mode ? "mode" : undefined,
    ].filter((flag): flag is string => flag !== undefined);
    const telemetryRoot: TelemetryCommand = {
      name: () => "clerk",
      options: [],
      getOptionValueSource: () => undefined,
      parent: null,
    };
    const telemetryApps: TelemetryCommand = {
      ...telemetryRoot,
      name: () => "apps",
      parent: telemetryRoot,
    };
    yield* Effect.sync(() =>
      startCommandTelemetry({
        name: () => "list",
        parent: telemetryApps,
        options: flags.map((flag) => ({ name: () => flag, attributeName: () => flag })),
        getOptionValueSource: () => "cli",
      }),
    );
    yield* Effect.try({
      try: () => initializeGlobalMode({ mode, verbose: globals.verbose }),
      catch: (cause) => new AppsFailure({ cause }),
    });
    const config = yield* AppsConfiguration;
    yield* Effect.flatMap(config.environment, (env) =>
      Effect.sync(() => initializeEnvironment(env)),
    );
    yield* listEffect(options);
    yield* Effect.tryPromise({
      try: async () => maybeNotifyUpdate(CURRENT_VERSION),
      catch: (cause) => new AppsFailure({ cause }),
    });
  }),
).pipe(Command.withDescription("List your Clerk applications"));
export const appsListCommand = root.pipe(
  Command.withSubcommands([
    Command.make("apps").pipe(
      Command.withDescription("Manage your Clerk applications"),
      Command.withSubcommands([listCommand]),
    ),
  ]),
);

/** The runner is the sole foreign boundary back to the legacy executable lifecycle. */
export async function runAppsList(args: readonly string[], layer = appsListLayer): Promise<void> {
  const argv = [...args];
  // Commander assigns repeated scalar options their last value. Effect CLI
  // retains the first; normalize this established input contract before parsing.
  let lastMode = -1;
  for (let i = 0; i < argv.length && argv[i] !== "--"; i++) {
    // Effect accepts boolean assignments; Clerk's existing switches do not.
    if (/^(--json|--verbose|--help|--version|-h|-v)=/.test(argv[i]!)) {
      throw new CliError(`unknown option '${argv[i]}'`, { exitCode: EXIT_CODE.GENERAL });
    }
    if (argv[i] === "--mode" || argv[i]!.startsWith("--mode=")) {
      if (lastMode >= 0) {
        const count = argv[lastMode] === "--mode" ? 2 : 1;
        argv.splice(lastMode, count);
        i -= count;
      }
      lastMode = i;
      if (argv[i] === "--mode") i++;
    }
  }
  let firstWord = -1;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--mode") {
      i++;
      continue;
    }
    if (argv[i]!.startsWith("-")) continue;
    firstWord = i;
    break;
  }
  if (firstWord >= 0 && argv[firstWord] === "help") {
    argv.splice(firstWord, 1);
    argv.push("--help");
  }
  const delimiter = argv.indexOf("--");
  const appsIndex = argv.indexOf("apps", Math.max(firstWord, 0));
  if (delimiter >= 0 && delimiter < appsIndex) {
    argv.splice(delimiter, 1);
    const listIndex = argv.indexOf("list", appsIndex - 1);
    argv.splice(listIndex + 1, 0, "--");
  }
  const helpOutput: string[] = [];
  const cliConsole = {
    ...globalThis.console,
    log: (...args: unknown[]) => helpOutput.push(args.map(String).join(" ")),
    error: (...args: unknown[]) => helpOutput.push(args.map(String).join(" ")),
  };
  const effect = Command.runWith(appsListCommand, {
    version: CURRENT_VERSION,
    renderErrors: false,
  })(argv).pipe(
    Effect.provide(Layer.mergeAll(BunServices.layer, layer)),
    Effect.provideService(Console.Console, cliConsole),
    Effect.provide(CliConfig.layer({ builtIns: [GlobalFlag.Help, GlobalFlag.Version] })),
    Effect.provide(
      CliOutput.layer({ ...CliOutput.defaultFormatter(), formatVersion: () => CURRENT_VERSION }),
    ),
  );
  const exit = await Effect.runPromiseExit(effect);
  if (Exit.isFailure(exit)) {
    for (const reason of exit.cause.reasons) {
      if (reason._tag === "Fail") {
        const error = reason.error;
        if (isAppsFailure(error)) throw error.cause;
        if (EffectCliError.isCliError(error)) {
          const parseError = error._tag === "ShowHelp" ? error.errors[0] : error;
          let message = parseError?.message ?? "Invalid arguments";
          if (parseError?._tag === "UnrecognizedOption")
            message = `unknown option '${parseError.option}'`;
          if (parseError?._tag === "MissingOption")
            message = `option '--${parseError.option} <${parseError.option}>' argument missing`;
          if (parseError?._tag === "UnexpectedArgument")
            message = `too many arguments for 'list'. Expected 0 arguments but got ${parseError.arguments.length}.`;
          throw new CliError(message, { exitCode: EXIT_CODE.GENERAL });
        }
        throw error;
      }
      if (reason._tag === "Die") throw reason.defect;
    }
  }
  if (helpOutput.length) log.data(helpOutput.join("\n"));
}
