/**
 * Wrappers around @clack/prompts primitives. Every prompt translates
 * clack's cancel symbol into a UserAbortError via throwUserAbort() so
 * call sites never deal with the symbol directly.
 */

import {
  confirm as clackConfirm,
  text as clackText,
  password as clackPassword,
} from "@clack/prompts";
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

/** Single-line text input. */
export async function text(config: {
  message: string;
  default?: string;
  placeholder?: string;
  validate?: (value: string | undefined) => string | Error | undefined;
}): Promise<string> {
  const result = await clackText({
    message: config.message,
    initialValue: config.default,
    placeholder: config.placeholder,
    validate: config.validate,
  });
  return unwrap(result);
}

/** Masked password input. */
export async function password(config: {
  message: string;
  validate?: (value: string | undefined) => string | Error | undefined;
}): Promise<string> {
  const result = await clackPassword({
    message: config.message,
    validate: config.validate,
  });
  return unwrap(result);
}
