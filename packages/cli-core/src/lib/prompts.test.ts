import { test, expect, mock, beforeEach, spyOn } from "bun:test";
import { captureLog } from "../test/lib/stubs.ts";

// Sentinel for cancellation. Tests choose this symbol; the mocked
// @clack/prompts.isCancel below treats it as the clack cancel signal.
const cancelSymbol = Symbol.for("clack:cancel");

let lastConfirmConfig: Record<string, unknown> | undefined;
let confirmResult: boolean | symbol = true;
let lastTextConfig: Record<string, unknown> | undefined;
let textResult: string | symbol = "";
let textResults: Array<string | symbol> = [];
let lastPasswordConfig: Record<string, unknown> | undefined;
let passwordResult: string | symbol = "";

interface EditorCall {
  text: string;
  opts: Record<string, unknown> | undefined;
}
let editorCalls: EditorCall[] = [];
let editorResults: string[] = [];

mock.module("@clack/prompts", () => ({
  confirm: async (config: Record<string, unknown>) => {
    lastConfirmConfig = config;
    return confirmResult;
  },
  text: async (config: Record<string, unknown>) => {
    lastTextConfig = config;
    return textResults.length > 0 ? textResults.shift()! : textResult;
  },
  password: async (config: Record<string, unknown>) => {
    lastPasswordConfig = config;
    return passwordResult;
  },
  isCancel: (value: unknown): value is symbol => value === cancelSymbol,
  // Stubs for other exports so this mock doesn't break sibling test files
  // that share this process and may import @clack/prompts.
  intro: () => {},
  outro: () => {},
  cancel: () => {},
  log: { info: () => {}, warn: () => {}, error: () => {}, success: () => {} },
  spinner: () => ({ start: () => {}, stop: () => {}, message: () => {} }),
}));

mock.module("external-editor", () => ({
  editAsync: (
    text: string,
    cb: (err: Error | null, value: string) => void,
    opts?: Record<string, unknown>,
  ) => {
    editorCalls.push({ text, opts });
    const next = editorResults.shift() ?? "";
    // Defer to next microtask so the wrapper's Promise resolves
    // through the same path it would in production.
    queueMicrotask(() => cb(null, next));
  },
}));

const { confirm, text, password, editor } = await import("./prompts.ts");

beforeEach(() => {
  lastConfirmConfig = undefined;
  confirmResult = true;
  lastTextConfig = undefined;
  textResult = "";
  textResults = [];
  lastPasswordConfig = undefined;
  passwordResult = "";
  editorCalls = [];
  editorResults = [];
  Object.defineProperty(process.stdin, "isTTY", {
    configurable: true,
    value: true,
  });
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

test("confirm opens the controlling terminal when stdin is not a TTY", async () => {
  Object.defineProperty(process.stdin, "isTTY", { configurable: true, value: false });
  const mockStream = { close: mock(() => {}), on: mock(() => mockStream) };
  const createReadStreamSpy = spyOn(await import("node:fs"), "createReadStream").mockReturnValue(
    mockStream as never,
  );

  await confirm({ message: "Continue?" });

  const expectedPath = process.platform === "win32" ? "CONIN$" : "/dev/tty";
  expect(createReadStreamSpy).toHaveBeenCalledWith(expectedPath);
  expect(lastConfirmConfig?.input).toBe(mockStream);
  expect(mockStream.close).toHaveBeenCalled();

  createReadStreamSpy.mockRestore();
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

  expect(lastTextConfig?.message).toBe("Name?");
  expect(lastTextConfig?.initialValue).toBe("anon");
  expect(lastTextConfig?.placeholder).toBe("type a name");
  expect(typeof lastTextConfig?.validate).toBe("function");
});

test("text throws UserAbortError when clack returns cancel symbol", async () => {
  textResult = cancelSymbol;

  await expect(text({ message: "Name?" })).rejects.toMatchObject({
    name: "UserAbortError",
  });
});

test("text maps true validation results to clack success", async () => {
  textResult = "value";
  await text({ message: "Name?", validate: () => true });

  const validate = lastTextConfig?.validate as (value: string | undefined) => unknown;
  expect(validate("value")).toBeUndefined();
});

test("text re-prompts when async validation rejects a submitted value", async () => {
  textResults = ["missing.json", "valid.json"];
  const captured = captureLog();

  const result = await captured.run(() =>
    text({
      message: "Path?",
      validate: async (value) => (value === "valid.json" ? true : "File not found"),
    }),
  );

  expect(result).toBe("valid.json");
  expect(captured.err).toContain("File not found");
});

test("password passes message to clack and returns the typed value", async () => {
  passwordResult = "s3cret";
  const result = await password({ message: "Secret?" });

  expect(result).toBe("s3cret");
  expect(lastPasswordConfig).toEqual({ message: "Secret?", validate: undefined });
});

test("password forwards validate to clack", async () => {
  passwordResult = "long-enough";
  const validate = (v: string | undefined) => ((v?.length ?? 0) >= 8 ? undefined : "too short");
  await password({ message: "Secret?", validate });

  expect(lastPasswordConfig?.message).toBe("Secret?");
  expect(typeof lastPasswordConfig?.validate).toBe("function");
});

test("password maps true validation results to clack success", async () => {
  passwordResult = "s3cret";
  await password({ message: "Secret?", validate: () => true });

  const validate = lastPasswordConfig?.validate as (value: string | undefined) => unknown;
  expect(validate("s3cret")).toBeUndefined();
});

test("password throws UserAbortError when clack returns cancel symbol", async () => {
  passwordResult = cancelSymbol;

  await expect(password({ message: "Secret?" })).rejects.toMatchObject({
    name: "UserAbortError",
  });
});

test("editor invokes external-editor with the default body and postfix", async () => {
  editorResults = ["my notes"];
  const captured = captureLog();

  const result = await captured.run(() =>
    editor({ message: "Notes?", default: "draft", postfix: ".md" }),
  );

  expect(result).toBe("my notes");
  expect(editorCalls).toHaveLength(1);
  expect(editorCalls[0]?.text).toBe("draft");
  expect(editorCalls[0]?.opts).toEqual({ postfix: ".md" });
  expect(captured.err).toContain("Notes?");
});

test("editor strips a single trailing newline from the editor output", async () => {
  editorResults = ["body\n"];
  const captured = captureLog();

  const result = await captured.run(() => editor({ message: "Notes?" }));

  expect(result).toBe("body");
});

test("editor re-prompts when validate returns an error message", async () => {
  editorResults = ["", "good"];
  const captured = captureLog();

  const result = await captured.run(() =>
    editor({
      message: "Notes?",
      validate: (v) => (v?.trim() ? undefined : "required"),
    }),
  );

  expect(result).toBe("good");
  expect(editorCalls).toHaveLength(2);
  expect(captured.err).toContain("required");
});

test("editor re-prompts when validate returns an Error", async () => {
  editorResults = ["bad", "ok"];
  const captured = captureLog();

  const result = await captured.run(() =>
    editor({
      message: "Notes?",
      validate: (v) => (v === "ok" ? undefined : new Error("not ok")),
    }),
  );

  expect(result).toBe("ok");
  expect(captured.err).toContain("not ok");
});
