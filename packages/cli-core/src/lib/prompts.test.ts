import { test, expect, mock, beforeEach } from "bun:test";

// Sentinel for cancellation. Tests choose this symbol; the mocked
// @clack/core.isCancel below treats it as the clack cancel signal.
const cancelSymbol = Symbol.for("clack:cancel");

let lastConfirmConfig: Record<string, unknown> | undefined;
let confirmResult: boolean | symbol = true;
let lastTextConfig: Record<string, unknown> | undefined;
let textResult: string | symbol = "";
let lastPasswordConfig: Record<string, unknown> | undefined;
let passwordResult: string | symbol = "";

mock.module("@clack/prompts", () => ({
  confirm: async (config: Record<string, unknown>) => {
    lastConfirmConfig = config;
    return confirmResult;
  },
  text: async (config: Record<string, unknown>) => {
    lastTextConfig = config;
    return textResult;
  },
  password: async (config: Record<string, unknown>) => {
    lastPasswordConfig = config;
    return passwordResult;
  },
  // Stubs for other exports so this mock doesn't break sibling test files
  // that share this process and may import @clack/prompts.
  intro: () => {},
  outro: () => {},
  cancel: () => {},
  log: { info: () => {}, warn: () => {}, error: () => {}, success: () => {} },
  spinner: () => ({ start: () => {}, stop: () => {}, message: () => {} }),
}));

mock.module("@clack/core", () => ({
  isCancel: (value: unknown): value is symbol => value === cancelSymbol,
}));

mock.module("external-editor", () => ({
  editAsync: (
    _text: string,
    _cb: (err: Error | null, value: string) => void,
    _opts?: Record<string, unknown>,
  ) => {
    // Real implementation overridden in editor tests via spyOn.
  },
}));

const { confirm, text, password } = await import("./prompts.ts");

beforeEach(() => {
  lastConfirmConfig = undefined;
  confirmResult = true;
  lastTextConfig = undefined;
  textResult = "";
  lastPasswordConfig = undefined;
  passwordResult = "";
});

test("confirm passes message to clack and returns true", async () => {
  confirmResult = true;
  const result = await confirm({ message: "Continue?" });

  expect(result).toBe(true);
  expect(lastConfirmConfig).toEqual({ message: "Continue?", initialValue: undefined });
});

test("confirm returns false when user declines", async () => {
  confirmResult = false;
  const result = await confirm({ message: "Continue?" });
  expect(result).toBe(false);
});

test("confirm translates default to initialValue", async () => {
  confirmResult = true;
  await confirm({ message: "Continue?", default: false });

  expect(lastConfirmConfig).toEqual({ message: "Continue?", initialValue: false });
});

test("confirm throws UserAbortError when clack returns cancel symbol", async () => {
  confirmResult = cancelSymbol;

  await expect(confirm({ message: "Continue?" })).rejects.toMatchObject({
    name: "UserAbortError",
  });
});

test("text passes message to clack and returns the typed value", async () => {
  textResult = "hello";
  const result = await text({ message: "Name?" });

  expect(result).toBe("hello");
  expect(lastTextConfig).toEqual({
    message: "Name?",
    initialValue: undefined,
    placeholder: undefined,
    validate: undefined,
  });
});

test("text forwards default, placeholder, and validate to clack", async () => {
  textResult = "value";
  const validate = (v: string | undefined) => (v?.trim() ? undefined : "required");
  await text({ message: "Name?", default: "anon", placeholder: "type a name", validate });

  expect(lastTextConfig).toEqual({
    message: "Name?",
    initialValue: "anon",
    placeholder: "type a name",
    validate,
  });
});

test("text throws UserAbortError when clack returns cancel symbol", async () => {
  textResult = cancelSymbol;

  await expect(text({ message: "Name?" })).rejects.toMatchObject({
    name: "UserAbortError",
  });
});

test("password passes message to clack and returns the typed value", async () => {
  passwordResult = "s3cret";
  const result = await password({ message: "Secret?" });

  expect(result).toBe("s3cret");
  expect(lastPasswordConfig).toEqual({ message: "Secret?", validate: undefined });
});

test("password forwards validate to clack", async () => {
  passwordResult = "ok";
  const validate = (v: string | undefined) => ((v?.length ?? 0) >= 8 ? undefined : "too short");
  await password({ message: "Secret?", validate });

  expect(lastPasswordConfig).toEqual({ message: "Secret?", validate });
});

test("password throws UserAbortError when clack returns cancel symbol", async () => {
  passwordResult = cancelSymbol;

  await expect(password({ message: "Secret?" })).rejects.toMatchObject({
    name: "UserAbortError",
  });
});
