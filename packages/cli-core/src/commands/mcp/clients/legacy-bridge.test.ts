import { describe, expect, test } from "bun:test";
import { isLegacyBridgeEntry } from "./legacy-bridge.ts";

describe("isLegacyBridgeEntry", () => {
  test.each([
    ["the standard { command, args } shape", { command: "clerk", args: ["mcp", "run"] }],
    ["VS Code's stdio-tagged shape", { type: "stdio", command: "clerk", args: ["mcp", "run"] }],
    ["opencode's argv-array shape", { type: "local", command: ["clerk", "mcp", "run"] }],
    [
      "a hand-edited entry with a --url arg",
      { command: "clerk", args: ["mcp", "run", "--url", "https://mcp.clerk.com/mcp"] },
    ],
  ])("recognizes %s", (_label, descriptor) => {
    expect(isLegacyBridgeEntry(descriptor)).toBe(true);
  });

  test.each([
    ["a URL entry", { url: "https://mcp.clerk.com/mcp" }],
    ["a different command", { command: "npx", args: ["-y", "mcp-remote", "x"] }],
    ["another clerk subcommand", { command: "clerk", args: ["mcp", "list"] }],
    ["a different argv-array command", { type: "local", command: ["npx", "mcp", "run"] }],
    ["missing args", { command: "clerk" }],
    ["not an object", "clerk mcp run"],
    ["null", null],
  ])("rejects %s", (_label, descriptor) => {
    expect(isLegacyBridgeEntry(descriptor)).toBe(false);
  });
});
