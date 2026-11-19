import type { CliError } from "../../../lib/errors.ts";

/**
 * Builds the error a native engine raises for a setup condition the user can act on, as opposed
 * to a bug in the CLI. Each engine binds its own error codes (`ios_setup_blocked`,
 * `android_setup_blocked`, and their `_stale` variants), so shared code takes the factory.
 */
export type SetupErrorFactory = (message: string, stale?: boolean) => CliError;
