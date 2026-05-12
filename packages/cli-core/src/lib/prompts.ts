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

import {
  confirm as inquirerConfirm,
  input as inquirerInput,
  password as inquirerPassword,
  editor as inquirerEditor,
} from "@inquirer/prompts";
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

/** Single-line text input. Named `text` to match the post-clack API. */
export async function text(config: {
  message: string;
  default?: string;
  validate?: (value: string) => boolean | string | Promise<boolean | string>;
}): Promise<string> {
  const tty = ttyContext();
  try {
    return await inquirerInput(config, tty ? { input: tty.input } : undefined);
  } finally {
    tty?.close();
  }
}

/** Masked password input. */
export async function password(config: {
  message: string;
  validate?: (value: string) => boolean | string | Promise<boolean | string>;
}): Promise<string> {
  const tty = ttyContext();
  try {
    return await inquirerPassword(config, tty ? { input: tty.input } : undefined);
  } finally {
    tty?.close();
  }
}

/** Multiline editor input ($EDITOR shellout). */
export async function editor(config: {
  message: string;
  default?: string;
  postfix?: string;
  validate?: (value: string) => boolean | string | Promise<boolean | string>;
}): Promise<string> {
  const tty = ttyContext();
  try {
    return await inquirerEditor(config, tty ? { input: tty.input } : undefined);
  } finally {
    tty?.close();
  }
}
