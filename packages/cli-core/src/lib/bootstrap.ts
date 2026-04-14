// packages/cli-core/src/lib/bootstrap.ts
/**
 * Pre-parse bootstrap shared by `cli.ts` (real CLI) and the integration test
 * harness. This is the four-phase setup that used to live in a Commander
 * `preAction` hook on the program: extract `--mode` from raw argv, persist
 * the active environment from config, and print the non-production banner.
 *
 * Phases:
 *   1. Reset log level; set debug if --verbose is present.
 *   2. Parse `--mode` from argv (before Commander touches it).
 *   3. Initialize the active environment from persisted config.
 *   4. Print the non-production env banner to stderr.
 *
 * Callers are responsible for constructing the Root and running the program
 * after `bootstrap()` resolves.
 */
import type { Need } from "./deps.ts";
import { setMode, type Mode } from "./mode.ts";
import { throwUsageError } from "./errors.ts";
import { setLogLevel } from "./log.ts";

export type BootstrapDeps = Need<{
  environment: "setCurrentEnv" | "isValidEnv" | "getCurrentEnvName";
  configStore: "getEnvironment";
}>;

export async function bootstrap(deps: BootstrapDeps, argv: string[]): Promise<void> {
  // Reset log level so a previous --verbose flag doesn't leak into subsequent runs.
  setLogLevel(argv.includes("--verbose") ? "debug" : "info");

  const mode = extractModeFromArgv(argv);
  if (mode) setMode(mode);

  const envName = await deps.configStore.getEnvironment();
  if (envName && deps.environment.isValidEnv(envName)) {
    deps.environment.setCurrentEnv(envName);
  }

  const activeEnv = deps.environment.getCurrentEnvName();
  if (activeEnv !== "production") {
    process.stderr.write(`[${activeEnv.toUpperCase()}]\n`);
  }
}

export function extractModeFromArgv(argv: string[]): Mode | undefined {
  // Scan the whole argv (not first-match) so a repeated `--mode <v> --mode <w>`
  // resolves to the last value, matching Commander's previous last-wins
  // behavior under the now-removed preAction hook. Validate every occurrence.
  let result: Mode | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    let v: string | undefined;
    if (a === "--mode" && argv[i + 1]) {
      v = argv[i + 1];
      i++;
    } else if (a.startsWith("--mode=")) {
      v = a.slice("--mode=".length);
    }
    if (v === undefined) continue;
    if (v !== "human" && v !== "agent") {
      throwUsageError(`Invalid mode "${v}". Must be "human" or "agent".`);
    }
    result = v;
  }
  return result;
}
