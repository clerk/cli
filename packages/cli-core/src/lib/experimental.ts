/**
 * Commands that ship to `main` before they're finished stay behind a name in
 * `CLERK_EXPERIMENTAL`, a comma-separated list. Names are trimmed and
 * case-insensitive, and unknown names are ignored.
 */
import { CliError, ERROR_CODE, EXIT_CODE } from "./errors.ts";

function enabledExperiments(env: NodeJS.ProcessEnv): Set<string> {
  return new Set(
    (env.CLERK_EXPERIMENTAL ?? "")
      .split(",")
      .map((name) => name.trim().toLowerCase())
      .filter(Boolean),
  );
}

export function isExperimentEnabled(name: string, env: NodeJS.ProcessEnv = process.env): boolean {
  return enabledExperiments(env).has(name.toLowerCase());
}

export function requireExperiment(name: string, env: NodeJS.ProcessEnv = process.env): void {
  if (isExperimentEnabled(name, env)) return;
  throw new CliError(
    `\`clerk ${name}\` is experimental. Set CLERK_EXPERIMENTAL=${name} to use it.`,
    { code: ERROR_CODE.EXPERIMENT_DISABLED, exitCode: EXIT_CODE.USAGE },
  );
}
