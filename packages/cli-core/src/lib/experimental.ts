/**
 * Gates for commands that ship to `main` before they're finished.
 *
 * A gated command stays behind a name in `CLERK_EXPERIMENTAL`, a
 * comma-separated list (`CLERK_EXPERIMENTAL=migrate,other`). Names are
 * trimmed and case-insensitive, and the gate ignores names it doesn't know.
 * Nothing is gated right now; `.claude/rules/commands.md` describes how to
 * gate a command and how to remove the gate when it ships.
 *
 * @example
 * // In the command group's register<Name>(), before building the real tree:
 * if (!isExperimentEnabled("my-command", env)) {
 *   const stub = program
 *     .command("my-command", { hidden: true })
 *     .helpOption(false)
 *     .allowUnknownOption()
 *     .allowExcessArguments()
 *     .argument("[args...]")
 *     .action(() => requireExperiment("my-command", env));
 *   stub.helpInformation = () => {
 *     requireExperiment("my-command", env);
 *     return "";
 *   };
 *   return;
 * }
 */
import { CliError, ERROR_CODE, EXIT_CODE } from "./errors.ts";

/**
 * Parse `CLERK_EXPERIMENTAL` into the set of experiments it turns on.
 *
 * @param env - The environment to read `CLERK_EXPERIMENTAL` from.
 * @returns The experiment names, trimmed and lowercased, with empty entries
 *   dropped. An unset or empty variable gives an empty set.
 */
function enabledExperiments(env: NodeJS.ProcessEnv): Set<string> {
  return new Set(
    (env.CLERK_EXPERIMENTAL ?? "")
      .split(",")
      .map((name) => name.trim().toLowerCase())
      .filter(Boolean),
  );
}

/**
 * Whether `CLERK_EXPERIMENTAL` turns on an experiment.
 *
 * Use it to decide what to register, for example a hidden stub in place of
 * the real command tree, so a gated command stays out of `clerk --help` and
 * shell completion.
 *
 * @param name - The experiment's name, usually the command's (`"migrate"`).
 *   Case-insensitive.
 * @param env - The environment to read `CLERK_EXPERIMENTAL` from. Defaults to
 *   `process.env`; tests pass their own.
 * @returns `true` when the list names the experiment, otherwise `false`.
 *
 * @example
 * isExperimentEnabled("migrate", { CLERK_EXPERIMENTAL: "other, Migrate" }); // true
 * isExperimentEnabled("migrate", {}); // false
 */
export function isExperimentEnabled(name: string, env: NodeJS.ProcessEnv = process.env): boolean {
  return enabledExperiments(env).has(name.toLowerCase());
}

/**
 * Stop the command unless `CLERK_EXPERIMENTAL` turns on its experiment.
 *
 * Call it from the gated command's action, and from its `helpInformation`
 * so `clerk help <name>` refuses too, so the user learns how to turn the
 * command on instead of seeing "unknown command".
 *
 * @param name - The experiment's name. The error message names it as
 *   `clerk <name>` and as the value to set.
 * @param env - The environment to read `CLERK_EXPERIMENTAL` from. Defaults to
 *   `process.env`.
 * @returns Nothing. It returns normally when the experiment is on.
 * @throws {CliError} When the experiment is off: code
 *   `ERROR_CODE.EXPERIMENT_DISABLED` (`experiment_disabled`), exit code
 *   `EXIT_CODE.USAGE` (2), and a message naming `CLERK_EXPERIMENTAL=<name>`.
 *
 * @example
 * requireExperiment("migrate", { CLERK_EXPERIMENTAL: "migrate" }); // returns
 * requireExperiment("migrate", {}); // throws: `clerk migrate` is experimental…
 */
export function requireExperiment(name: string, env: NodeJS.ProcessEnv = process.env): void {
  if (isExperimentEnabled(name, env)) return;
  throw new CliError(
    `\`clerk ${name}\` is experimental. Set CLERK_EXPERIMENTAL=${name} to use it.`,
    { code: ERROR_CODE.EXPERIMENT_DISABLED, exitCode: EXIT_CODE.USAGE },
  );
}
