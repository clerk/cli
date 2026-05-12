import { test, expect, mock, spyOn, beforeEach } from "bun:test";

// Track calls to the underlying inquirer primitives
let lastConfirmArgs: unknown[] = [];
let confirmResult: boolean | Error = true;
let lastInputArgs: unknown[] = [];
let inputResult: string | Error = "";
let lastPasswordArgs: unknown[] = [];
let passwordResult: string | Error = "";
let lastEditorArgs: unknown[] = [];
let editorResult: string | Error = "";

mock.module("@inquirer/prompts", () => ({
  confirm: async (...args: unknown[]) => {
    lastConfirmArgs = args;
    if (confirmResult instanceof Error) throw confirmResult;
    return confirmResult;
  },
  input: async (...args: unknown[]) => {
    lastInputArgs = args;
    if (inputResult instanceof Error) throw inputResult;
    return inputResult;
  },
  password: async (...args: unknown[]) => {
    lastPasswordArgs = args;
    if (passwordResult instanceof Error) throw passwordResult;
    return passwordResult;
  },
  editor: async (...args: unknown[]) => {
    lastEditorArgs = args;
    if (editorResult instanceof Error) throw editorResult;
    return editorResult;
  },
  // Stub the other exports so this mock doesn't break other test files
  // that share this process and import @inquirer/prompts.
  select: async () => {},
  search: async () => {},
}));

const { confirm, text, password, editor } = await import("./prompts.ts");

const originalIsTTY = process.stdin.isTTY;
const originalPlatform = process.platform;

beforeEach(() => {
  lastConfirmArgs = [];
  confirmResult = true;
  lastInputArgs = [];
  inputResult = "";
  lastPasswordArgs = [];
  passwordResult = "";
  lastEditorArgs = [];
  editorResult = "";
  process.stdin.isTTY = originalIsTTY;
  Object.defineProperty(process, "platform", { value: originalPlatform, writable: true });
});

test("passes config through to inquirer confirm", async () => {
  process.stdin.isTTY = true;
  const result = await confirm({ message: "Continue?" });

  expect(result).toBe(true);
  expect(lastConfirmArgs[0]).toEqual({ message: "Continue?" });
});

test("returns false when user declines", async () => {
  process.stdin.isTTY = true;
  confirmResult = false;
  const result = await confirm({ message: "Continue?" });
  expect(result).toBe(false);
});

test("does not open tty when stdin is a TTY", async () => {
  process.stdin.isTTY = true;
  await confirm({ message: "Continue?" });

  // Second arg (context) should be undefined — no tty input needed
  expect(lastConfirmArgs[1]).toBeUndefined();
});

test("opens controlling terminal as input when stdin is not a TTY", async () => {
  process.stdin.isTTY = false;

  const mockStream = { close: mock(() => {}), on: mock(() => mockStream) };
  const createReadStreamSpy = spyOn(await import("node:fs"), "createReadStream").mockReturnValue(
    mockStream as any,
  );

  await confirm({ message: "Continue?" });

  // Should use the platform-appropriate TTY path
  const expectedPath = process.platform === "win32" ? "CONIN$" : "/dev/tty";
  expect(createReadStreamSpy).toHaveBeenCalledWith(expectedPath);
  expect(lastConfirmArgs[1]).toEqual({ input: mockStream });
  expect(mockStream.close).toHaveBeenCalled();

  createReadStreamSpy.mockRestore();
});

test("closes tty stream even when confirm throws", async () => {
  process.stdin.isTTY = false;
  confirmResult = new Error("user cancelled");

  const mockStream = { close: mock(() => {}), on: mock(() => mockStream) };
  const createReadStreamSpy = spyOn(await import("node:fs"), "createReadStream").mockReturnValue(
    mockStream as any,
  );

  await expect(confirm({ message: "Continue?" })).rejects.toThrow("user cancelled");
  expect(mockStream.close).toHaveBeenCalled();

  createReadStreamSpy.mockRestore();
});

test("text passes config through to inquirer input", async () => {
  process.stdin.isTTY = true;
  inputResult = "hello";
  const result = await text({ message: "Name?" });

  expect(result).toBe("hello");
  expect(lastInputArgs[0]).toEqual({ message: "Name?" });
});

test("text forwards default and validate options", async () => {
  process.stdin.isTTY = true;
  inputResult = "value";
  const validate = (v: string) => v.length > 0;
  await text({ message: "Name?", default: "anon", validate });

  expect(lastInputArgs[0]).toEqual({ message: "Name?", default: "anon", validate });
});

test("text does not open tty when stdin is a TTY", async () => {
  process.stdin.isTTY = true;
  await text({ message: "Name?" });

  expect(lastInputArgs[1]).toBeUndefined();
});

test("text opens controlling terminal when stdin is not a TTY", async () => {
  process.stdin.isTTY = false;

  const mockStream = { close: mock(() => {}), on: mock(() => mockStream) };
  const createReadStreamSpy = spyOn(await import("node:fs"), "createReadStream").mockReturnValue(
    mockStream as any,
  );

  await text({ message: "Name?" });

  expect(lastInputArgs[1]).toEqual({ input: mockStream });
  expect(mockStream.close).toHaveBeenCalled();

  createReadStreamSpy.mockRestore();
});

test("text closes tty stream even when inquirer input throws", async () => {
  process.stdin.isTTY = false;
  inputResult = new Error("cancelled");

  const mockStream = { close: mock(() => {}), on: mock(() => mockStream) };
  const createReadStreamSpy = spyOn(await import("node:fs"), "createReadStream").mockReturnValue(
    mockStream as any,
  );

  await expect(text({ message: "Name?" })).rejects.toThrow("cancelled");
  expect(mockStream.close).toHaveBeenCalled();

  createReadStreamSpy.mockRestore();
});

test("password passes config through to inquirer password", async () => {
  process.stdin.isTTY = true;
  passwordResult = "s3cret";
  const result = await password({ message: "Secret?" });

  expect(result).toBe("s3cret");
  expect(lastPasswordArgs[0]).toEqual({ message: "Secret?" });
});

test("password forwards validate option", async () => {
  process.stdin.isTTY = true;
  const validate = (v: string) => v.length >= 8;
  await password({ message: "Secret?", validate });

  expect(lastPasswordArgs[0]).toEqual({ message: "Secret?", validate });
});

test("password does not open tty when stdin is a TTY", async () => {
  process.stdin.isTTY = true;
  await password({ message: "Secret?" });

  expect(lastPasswordArgs[1]).toBeUndefined();
});

test("password opens controlling terminal when stdin is not a TTY", async () => {
  process.stdin.isTTY = false;

  const mockStream = { close: mock(() => {}), on: mock(() => mockStream) };
  const createReadStreamSpy = spyOn(await import("node:fs"), "createReadStream").mockReturnValue(
    mockStream as any,
  );

  await password({ message: "Secret?" });

  expect(lastPasswordArgs[1]).toEqual({ input: mockStream });
  expect(mockStream.close).toHaveBeenCalled();

  createReadStreamSpy.mockRestore();
});

test("password closes tty stream even when inquirer password throws", async () => {
  process.stdin.isTTY = false;
  passwordResult = new Error("cancelled");

  const mockStream = { close: mock(() => {}), on: mock(() => mockStream) };
  const createReadStreamSpy = spyOn(await import("node:fs"), "createReadStream").mockReturnValue(
    mockStream as any,
  );

  await expect(password({ message: "Secret?" })).rejects.toThrow("cancelled");
  expect(mockStream.close).toHaveBeenCalled();

  createReadStreamSpy.mockRestore();
});

test("editor passes config through to inquirer editor", async () => {
  process.stdin.isTTY = true;
  editorResult = "body content";
  const result = await editor({ message: "Notes?" });

  expect(result).toBe("body content");
  expect(lastEditorArgs[0]).toEqual({ message: "Notes?" });
});

test("editor forwards default, postfix, and validate options", async () => {
  process.stdin.isTTY = true;
  const validate = (v: string) => v.length > 0;
  await editor({ message: "Notes?", default: "draft", postfix: ".md", validate });

  expect(lastEditorArgs[0]).toEqual({
    message: "Notes?",
    default: "draft",
    postfix: ".md",
    validate,
  });
});

test("editor does not open tty when stdin is a TTY", async () => {
  process.stdin.isTTY = true;
  await editor({ message: "Notes?" });

  expect(lastEditorArgs[1]).toBeUndefined();
});

test("editor opens controlling terminal when stdin is not a TTY", async () => {
  process.stdin.isTTY = false;

  const mockStream = { close: mock(() => {}), on: mock(() => mockStream) };
  const createReadStreamSpy = spyOn(await import("node:fs"), "createReadStream").mockReturnValue(
    mockStream as any,
  );

  await editor({ message: "Notes?" });

  expect(lastEditorArgs[1]).toEqual({ input: mockStream });
  expect(mockStream.close).toHaveBeenCalled();

  createReadStreamSpy.mockRestore();
});

test("editor closes tty stream even when inquirer editor throws", async () => {
  process.stdin.isTTY = false;
  editorResult = new Error("cancelled");

  const mockStream = { close: mock(() => {}), on: mock(() => mockStream) };
  const createReadStreamSpy = spyOn(await import("node:fs"), "createReadStream").mockReturnValue(
    mockStream as any,
  );

  await expect(editor({ message: "Notes?" })).rejects.toThrow("cancelled");
  expect(mockStream.close).toHaveBeenCalled();

  createReadStreamSpy.mockRestore();
});
