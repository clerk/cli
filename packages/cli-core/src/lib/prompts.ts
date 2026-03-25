/**
 * Prompt helpers that handle edge cases like piped stdin.
 *
 * When stdin is piped (e.g. `clerk config pull | clerk config patch`),
 * it gets consumed reading the input data. Interactive prompts then fail
 * because stdin is at EOF. These helpers open /dev/tty as a fallback
 * input so prompts can still read from the user's terminal.
 */

import { createReadStream } from "node:fs";
import { confirm as inquirerConfirm } from "@inquirer/prompts";

/**
 * Like `confirm()` from @inquirer/prompts, but works even when stdin
 * has been consumed by a pipe. Falls back to reading from /dev/tty.
 */
export async function confirm(config: { message: string; default?: boolean }): Promise<boolean> {
  const ttyInput = process.stdin.isTTY ? undefined : createReadStream("/dev/tty");
  try {
    return await inquirerConfirm(config, ttyInput ? { input: ttyInput } : undefined);
  } finally {
    ttyInput?.close();
  }
}
