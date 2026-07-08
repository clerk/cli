import { test, expect, describe } from "bun:test";
import { formatExamplesBlock, type Example } from "./help.ts";

const ANSI_ESCAPE_PATTERN = new RegExp(String.raw`\[[0-9;]*m`, "g");
const stripAnsi = (value: string): string => value.replace(ANSI_ESCAPE_PATTERN, "");

describe("formatExamplesBlock", () => {
  test("returns an empty string for no examples", () => {
    expect(formatExamplesBlock([])).toBe("");
  });

  test("titles the block and prefixes each command with `$ `", () => {
    const block = stripAnsi(
      formatExamplesBlock([
        { command: "clerk webhooks listen --forward-to url", description: "Forward" },
      ]),
    );
    expect(block).toBe("Examples:\n  $ clerk webhooks listen --forward-to url  Forward");
  });

  test("aligns descriptions to the longest command", () => {
    const examples: Example[] = [
      { command: "short", description: "A" },
      { command: "a much longer command", description: "B" },
    ];
    const lines = stripAnsi(formatExamplesBlock(examples)).split("\n");
    // Both descriptions start at the same column.
    expect(lines[1]!.indexOf("A")).toBe(lines[2]!.indexOf("B"));
  });
});
