import { describe, expect, test } from "bun:test";
import { clerkRunArgs, extractClerkRunUrl, RUN_COMMAND } from "./clerk-run.ts";

const URL = "https://mcp.clerk.com/mcp";

describe("clerk-run descriptor", () => {
  test("clerkRunArgs builds the run invocation", () => {
    expect(clerkRunArgs(URL)).toEqual(["mcp", "run", "--url", URL]);
  });

  test("round-trips the URL it encodes", () => {
    expect(extractClerkRunUrl({ command: RUN_COMMAND, args: clerkRunArgs(URL) })).toBe(URL);
  });

  test("accepts the --url=value inline form", () => {
    expect(extractClerkRunUrl({ command: "clerk", args: ["mcp", "run", `--url=${URL}`] })).toBe(
      URL,
    );
  });

  test("ignores a vscode-style descriptor with an extra type field", () => {
    expect(extractClerkRunUrl({ type: "stdio", command: "clerk", args: clerkRunArgs(URL) })).toBe(
      URL,
    );
  });

  test.each([
    ["a different command", { command: "npx", args: ["-y", "mcp-remote", URL] }],
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
