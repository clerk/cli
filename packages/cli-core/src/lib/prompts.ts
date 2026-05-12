/**
 * Wrappers around @clack/prompts primitives. Every prompt translates
 * clack's cancel symbol into a UserAbortError via throwUserAbort() so
 * call sites never deal with the symbol directly.
 */

import { confirm as clackConfirm } from "@clack/prompts";
import { isCancel } from "@clack/core";
import { throwUserAbort } from "./errors.ts";

function unwrap<T>(value: T | symbol): T {
  if (isCancel(value)) throwUserAbort();
  return value as T;
}

/** Yes/no confirmation. */
export async function confirm(config: { message: string; default?: boolean }): Promise<boolean> {
  const result = await clackConfirm({
    message: config.message,
    initialValue: config.default,
  });
  return unwrap(result);
}
