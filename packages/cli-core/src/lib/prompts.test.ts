import { test, expect, mock, spyOn, beforeEach } from "bun:test";

// Track calls to the underlying inquirer confirm
let lastConfirmArgs: unknown[] = [];
let confirmResult: boolean | Error = true;

mock.module("@inquirer/prompts", () => ({
  confirm: async (...args: unknown[]) => {
    lastConfirmArgs = args;
    if (confirmResult instanceof Error) throw confirmResult;
    return confirmResult;
  },
  // Stub the other exports so this mock doesn't break other test files
  // that share this process and import @inquirer/prompts.
  select: async () => {},
  search: async () => {},
  input: async () => "",
  password: async () => "",
  editor: async () => "",
}));

const { confirm } = await import("./prompts.ts");

const originalIsTTY = process.stdin.isTTY;

beforeEach(() => {
  lastConfirmArgs = [];
  confirmResult = true;
  process.stdin.isTTY = originalIsTTY;
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

test("does not open /dev/tty when stdin is a TTY", async () => {
  process.stdin.isTTY = true;
  await confirm({ message: "Continue?" });

  // Second arg (context) should be undefined — no tty input needed
  expect(lastConfirmArgs[1]).toBeUndefined();
});

test("opens /dev/tty as input when stdin is not a TTY", async () => {
  process.stdin.isTTY = false;

  const mockStream = { close: mock(() => {}) };
  const createReadStreamSpy = spyOn(await import("node:fs"), "createReadStream").mockReturnValue(
    mockStream as any,
  );

  await confirm({ message: "Continue?" });

  expect(createReadStreamSpy).toHaveBeenCalledWith("/dev/tty");
  expect(lastConfirmArgs[1]).toEqual({ input: mockStream });
  expect(mockStream.close).toHaveBeenCalled();

  createReadStreamSpy.mockRestore();
});

test("closes /dev/tty stream even when confirm throws", async () => {
  process.stdin.isTTY = false;
  confirmResult = new Error("user cancelled");

  const mockStream = { close: mock(() => {}) };
  const createReadStreamSpy = spyOn(await import("node:fs"), "createReadStream").mockReturnValue(
    mockStream as any,
  );

  await expect(confirm({ message: "Continue?" })).rejects.toThrow("user cancelled");
  expect(mockStream.close).toHaveBeenCalled();

  createReadStreamSpy.mockRestore();
});
