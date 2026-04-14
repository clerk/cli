/**
 * Env collaborator.
 *
 * Wraps `process.env` reads so commands can access env vars through
 * `deps.env.*` instead of touching the global `process.env`. The `require`
 * variant throws a `CliError` if the variable is missing, which gives a
 * consistent user-facing message for "you forgot to set X".
 */

import { CliError } from "./errors.ts";

export interface Env {
  get(name: string): string | undefined;
  require(name: string): string;
}

export function createEnv(): Env {
  return {
    get: (name) => process.env[name],
    require: (name) => {
      const value = process.env[name];
      if (value === undefined || value === "") {
        throw new CliError(`Missing required environment variable: ${name}`);
      }
      return value;
    },
  };
}
