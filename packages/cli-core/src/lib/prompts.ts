/**
 * Prompt helpers that handle edge cases like piped stdin.
 *
 * When stdin is piped (e.g. `clerk config pull | clerk config patch`),
 * it gets consumed reading the input data. Interactive prompts then fail
 * because stdin is at EOF. These helpers open the controlling terminal
 * as a fallback input so prompts can still read from the user's terminal.
 *
 * Uses /dev/tty on Unix and CONIN$ on Windows.
 */

import { createReadStream } from "node:fs";
import {
  confirm as inquirerConfirm,
  select as inquirerSelect,
  search as inquirerSearch,
  input as inquirerInput,
} from "@inquirer/prompts";

/** OS-specific path to the controlling terminal's input stream. */
const TTY_PATH = process.platform === "win32" ? "CONIN$" : "/dev/tty";

/**
 * Like `confirm()` from @inquirer/prompts, but works even when stdin
 * has been consumed by a pipe. Falls back to reading from the
 * controlling terminal.
 */
export async function confirm(config: { message: string; default?: boolean }): Promise<boolean> {
  const ttyInput = process.stdin.isTTY ? undefined : createReadStream(TTY_PATH);
  try {
    return await inquirerConfirm(config, ttyInput ? { input: ttyInput } : undefined);
  } finally {
    ttyInput?.close();
  }
}

/**
 * Like `select()` from @inquirer/prompts, but with the same piped-stdin
 * fallback as {@link confirm} above.
 */
export async function select<T>(config: {
  message: string;
  choices: ReadonlyArray<{ name: string; value: T; description?: string }>;
  default?: T;
}): Promise<T> {
  const ttyInput = process.stdin.isTTY ? undefined : createReadStream(TTY_PATH);
  try {
    return await inquirerSelect<T>(config, ttyInput ? { input: ttyInput } : undefined);
  } finally {
    ttyInput?.close();
  }
}

/**
 * Like `search()` from @inquirer/prompts, re-exported under the Prompts
 * namespace. Uses stdin directly; source function selects from results.
 */
export async function search<T>(config: {
  message: string;
  source: (
    term: string | undefined,
  ) =>
    | ReadonlyArray<{ name: string; value: T; description?: string }>
    | Promise<ReadonlyArray<{ name: string; value: T; description?: string }>>;
}): Promise<T> {
  const ttyInput = process.stdin.isTTY ? undefined : createReadStream(TTY_PATH);
  try {
    return await inquirerSearch<T>(config, ttyInput ? { input: ttyInput } : undefined);
  } finally {
    ttyInput?.close();
  }
}

/**
 * Like `input()` from @inquirer/prompts, with the piped-stdin fallback.
 */
export async function input(config: {
  message: string;
  default?: string;
  validate?: (value: string) => boolean | string | Promise<boolean | string>;
}): Promise<string> {
  const ttyInput = process.stdin.isTTY ? undefined : createReadStream(TTY_PATH);
  try {
    return await inquirerInput(config, ttyInput ? { input: ttyInput } : undefined);
  } finally {
    ttyInput?.close();
  }
}

export interface Prompts {
  confirm(config: { message: string; default?: boolean }): Promise<boolean>;
  select<T>(config: {
    message: string;
    choices: ReadonlyArray<{ name: string; value: T; description?: string }>;
    default?: T;
  }): Promise<T>;
  search<T>(config: {
    message: string;
    source: (
      term: string | undefined,
    ) =>
      | ReadonlyArray<{ name: string; value: T; description?: string }>
      | Promise<ReadonlyArray<{ name: string; value: T; description?: string }>>;
  }): Promise<T>;
  input(config: {
    message: string;
    default?: string;
    validate?: (value: string) => boolean | string | Promise<boolean | string>;
  }): Promise<string>;
}

export const prompts: Prompts = {
  confirm,
  select,
  search,
  input,
};
