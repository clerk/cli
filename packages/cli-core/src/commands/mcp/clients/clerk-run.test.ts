import { describe, expect, test } from "bun:test";
import { clerkRunArgs, extractClerkRunUrl, isClerkRunEntry, RUN_COMMAND } from "./clerk-run.ts";

describe("clerk-run descriptor", () => {
  test("clerkRunArgs builds the run invocation without a URL", () => {
    expect(clerkRunArgs()).toEqual(["mcp", "run"]);
  });

  test("isClerkRunEntry recognises the current no-URL shape", () => {
    expect(isClerkRunEntry({ command: RUN_COMMAND, args: clerkRunArgs() })).toBe(true);
  });

  test("isClerkRunEntry rejects a legacy --url entry", () => {
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

  describe("extractClerkRunUrl (legacy migration)", () => {
    const LEGACY_URL = "https://mcp.clerk.com/mcp";

    test("extracts the URL from a legacy --url entry", () => {
      expect(
        extractClerkRunUrl({ command: "clerk", args: ["mcp", "run", "--url", LEGACY_URL] }),
      ).toBe(LEGACY_URL);
    });

    test("accepts the --url=value inline form", () => {
      expect(
        extractClerkRunUrl({ command: "clerk", args: ["mcp", "run", `--url=${LEGACY_URL}`] }),
      ).toBe(LEGACY_URL);
    });

    test("ignores a vscode-style descriptor with an extra type field", () => {
      expect(
        extractClerkRunUrl({
          type: "stdio",
          command: "clerk",
          args: ["mcp", "run", "--url", LEGACY_URL],
        }),
      ).toBe(LEGACY_URL);
    });

    test.each([
      ["a different command", { command: "npx", args: ["-y", "mcp-remote", LEGACY_URL] }],
      ["no --url flag", { command: "clerk", args: ["mcp", "run"] }],
      ["a trailing --url with no value", { command: "clerk", args: ["mcp", "run", "--url"] }],
      ["an empty --url= inline form", { command: "clerk", args: ["mcp", "run", "--url="] }],
      ["non-string args", { command: "clerk", args: [1, 2, 3] }],
      ["not an object", "clerk mcp run"],
      ["null", null],
    ])("returns undefined for %s", (_label, descriptor) => {
      expect(extractClerkRunUrl(descriptor)).toBeUndefined();
    });
  });
});
