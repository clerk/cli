/**
 * Prompt helpers that handle edge cases like piped stdin.
 *
 * When stdin is piped (e.g. `clerk config pull | clerk config patch`),
 * it gets consumed reading the input data. Interactive prompts then fail
 * because stdin is at EOF. These helpers open the controlling terminal
 * as a fallback input so prompts can still read from the user's terminal.
 *
 * Uses the shared ttyContext from lib/listage.ts for consistent error handling.
 */

import { confirm as inquirerConfirm } from "@inquirer/prompts";
import { ttyContext } from "./listage.ts";

/**
 * Like `confirm()` from @inquirer/prompts, but works even when stdin
 * has been consumed by a pipe. Falls back to reading from the
 * controlling terminal.
 */
export async function confirm(config: { message: string; default?: boolean }): Promise<boolean> {
  const tty = ttyContext();
  try {
    return await inquirerConfirm(config, tty ? { input: tty.input } : undefined);
  } finally {
    tty?.close();
  }
}
