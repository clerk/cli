/**
 * Wrappers around @clack/prompts primitives. Every prompt translates
 * clack's cancel symbol into a UserAbortError via throwUserAbort() so
 * call sites never deal with the symbol directly.
 */

import {
  confirm as clackConfirm,
  isCancel,
  text as clackText,
  password as clackPassword,
} from "@clack/prompts";
import { editAsync } from "external-editor";
import { throwUserAbort } from "./errors.ts";
import { log } from "./log.ts";

type ValidationResult = string | Error | true | undefined;
type Validate = (value: string | undefined) => ValidationResult | Promise<ValidationResult>;

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
  validate?: Validate;
}): Promise<string> {
  const result = await clackText({
    message: config.message,
    initialValue: config.default,
    placeholder: config.placeholder,
    validate: config.validate as (value: string | undefined) => string | Error | undefined,
  });
  return unwrap(result);
}

/** Masked password input. */
export async function password(config: { message: string; validate?: Validate }): Promise<string> {
  const result = await clackPassword({
    message: config.message,
    validate: config.validate as (value: string | undefined) => string | Error | undefined,
  });
  return unwrap(result);
}

/** Multi-line editor input. Shells out to $EDITOR via external-editor. */
export async function editor(config: {
  message: string;
  default?: string;
  postfix?: string;
  validate?: (value: string | undefined) => string | Error | undefined;
}): Promise<string> {
  log.info(config.message);

  for (;;) {
    const raw = await new Promise<string>((resolve, reject) => {
      editAsync(config.default ?? "", (err, value) => (err ? reject(err) : resolve(value)), {
        postfix: config.postfix,
      });
    });

    const trimmed = raw.replace(/\n$/, "");
    if (!config.validate) return trimmed;

    const verdict = config.validate(trimmed);
    if (verdict === undefined) return trimmed;
    log.warn(typeof verdict === "string" ? verdict : verdict.message);
  }
}
