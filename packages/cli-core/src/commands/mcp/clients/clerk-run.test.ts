import { describe, expect, test } from "bun:test";
import { clerkRunArgs, isClerkRunEntry, RUN_COMMAND } from "./clerk-run.ts";

describe("clerk-run descriptor", () => {
  test("clerkRunArgs builds the run invocation without a URL", () => {
    expect(clerkRunArgs()).toEqual(["mcp", "run"]);
  });

  test("isClerkRunEntry recognises the current no-URL shape", () => {
    expect(isClerkRunEntry({ command: RUN_COMMAND, args: clerkRunArgs() })).toBe(true);
  });

  test("isClerkRunEntry rejects an entry with a --url arg (never a shape this CLI wrote)", () => {
    expect(
      isClerkRunEntry({
        command: "clerk",
        args: ["mcp", "run", "--url", "https://mcp.clerk.com/mcp"],
      }),
    ).toBe(false);
  });

  test("isClerkRunEntry accepts a vscode-style descriptor with an extra type field", () => {
    // VS Code encodes stdio servers with a `type: "stdio"` discriminator; the
    // entry is still a current-format Clerk bridge.
    expect(isClerkRunEntry({ type: "stdio", command: "clerk", args: clerkRunArgs() })).toBe(true);
  });

  test.each([
    ["a different command", { command: "npx", args: ["-y", "mcp-remote", "x"] }],
    ["non-string args", { command: "clerk", args: [1, 2, 3] }],
    ["not an object", "clerk mcp run"],
    ["null", null],
  ])("isClerkRunEntry rejects %s", (_label, descriptor) => {
    expect(isClerkRunEntry(descriptor)).toBe(false);
  });
});
