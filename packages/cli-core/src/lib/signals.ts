import { EXIT_CODE } from "./errors.ts";

/**
 * The CLI's default SIGINT handler: exit with the conventional 130 code.
 * Exported as a named function so commands that install their own graceful
 * SIGINT handling (e.g. `webhooks listen`) can remove *only* this one via
 * `process.removeListener("SIGINT", cliSigintHandler)` instead of nuking all
 * SIGINT listeners.
 */
export const cliSigintHandler = (): never => process.exit(EXIT_CODE.SIGINT);
