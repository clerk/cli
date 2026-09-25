import { test, expect } from "bun:test";
import { join } from "node:path";
import { createProgram } from "./cli-program.ts";

const README_PATH = join(import.meta.dir, "../../../README.md");

const ANSI_ESCAPE_PATTERN = new RegExp(String.raw`\x1b\[[0-9;]*m`, "g");
const stripAnsi = (value: string): string => value.replace(ANSI_ESCAPE_PATTERN, "");

/** The fenced code block under `## Usage` that mirrors `clerk --help`. */
function readmeUsageBlock(readme: string): string {
  const match = readme.match(/## Usage\n+```\n(Usage: clerk[\s\S]*?)```/);
  if (!match) throw new Error(`No usage block found in ${README_PATH}`);
  return match[1]!.trim();
}

test("README usage block matches `clerk --help` output", async () => {
  const readme = await Bun.file(README_PATH).text();
  const program = createProgram();
  // The committed block is rendered at the 80-column non-TTY fallback width;
  // pin it so the test doesn't depend on the local terminal size.
  program.configureOutput({ getOutHelpWidth: () => 80 });
  const help = stripAnsi(program.helpInformation()).trim();

  expect(readmeUsageBlock(readme)).toBe(help);
});
