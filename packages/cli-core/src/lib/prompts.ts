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
  multiselect as clackMultiselect,
  type Option as ClackOption,
} from "@clack/prompts";
import { editAsync } from "external-editor";
import { throwUserAbort } from "./errors.ts";
import { ttyContext } from "./listage.ts";
import { log } from "./log.ts";

type ValidationResult = string | Error | true | undefined;
type Validate = (value: string | undefined) => ValidationResult | Promise<ValidationResult>;
type SyncValidate = (value: string | undefined) => string | Error | undefined;

function unwrap<T>(value: T | symbol): T {
  if (isCancel(value)) throwUserAbort();
  return value as T;
}

function isPromiseLike<T>(value: T | Promise<T>): value is Promise<T> {
  return typeof (value as Promise<T>)?.then === "function";
}

function validationError(result: ValidationResult): string | Error | undefined {
  return result === true ? undefined : result;
}

function createValidator(validate: Validate | undefined):
  | {
      sync: SyncValidate;
      final: (value: string | undefined) => Promise<string | Error | undefined>;
    }
  | undefined {
  if (!validate) return undefined;

  let last:
    | {
        value: string | undefined;
        result: ValidationResult | Promise<ValidationResult>;
      }
    | undefined;

  return {
    sync(value) {
      const result = validate(value);
      last = { value, result };
      if (isPromiseLike(result)) return undefined;
      return validationError(result);
    },
    async final(value) {
      const result = last && last.value === value ? last.result : validate(value);
      return validationError(await result);
    },
  };
}

function logValidationError(error: string | Error) {
  log.warn(typeof error === "string" ? error : error.message);
}

/** Yes/no confirmation. */
export async function confirm(config: { message: string; default?: boolean }): Promise<boolean> {
  const tty = ttyContext();
  try {
    const result = await clackConfirm({
      message: config.message,
      initialValue: config.default,
      input: tty?.input,
    });
    return unwrap(result);
  } finally {
    tty?.close();
  }
}

/** Multi-select checklist. Returns the chosen values (at least one when required). */
export async function multiselect<T>(config: {
  message: string;
  options: { value: T; label: string; hint?: string }[];
  initialValues?: T[];
  required?: boolean;
}): Promise<T[]> {
  const tty = ttyContext();
  try {
    const result = await clackMultiselect<T>({
      message: config.message,
      // `Option<T>` is a conditional type a naked generic can't satisfy
      // structurally; our shape provides `value` + `label`, valid in both branches.
      options: config.options as ClackOption<T>[],
      initialValues: config.initialValues,
      required: config.required ?? true,
      input: tty?.input,
    });
    return unwrap(result);
  } finally {
    tty?.close();
  }
}

/** Single-line text input. */
export async function text(config: {
  message: string;
  default?: string;
  placeholder?: string;
  validate?: Validate;
}): Promise<string> {
  const validator = createValidator(config.validate);

  for (;;) {
    const tty = ttyContext();
    try {
      const result = await clackText({
        message: config.message,
        initialValue: config.default,
        placeholder: config.placeholder,
        validate: validator?.sync,
        input: tty?.input,
      });
      const value = unwrap(result);
      const error = await validator?.final(value);
      if (!error) return value;
      logValidationError(error);
    } finally {
      tty?.close();
    }
  }
}

/** Masked password input. */
export async function password(config: { message: string; validate?: Validate }): Promise<string> {
  const validator = createValidator(config.validate);

  for (;;) {
    const tty = ttyContext();
    try {
      const result = await clackPassword({
        message: config.message,
        validate: validator?.sync,
        input: tty?.input,
      });
      const value = unwrap(result);
      const error = await validator?.final(value);
      if (!error) return value;
      logValidationError(error);
    } finally {
      tty?.close();
    }
  }
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
