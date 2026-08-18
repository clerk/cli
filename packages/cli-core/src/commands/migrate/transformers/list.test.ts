import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CliError } from "../../../lib/errors.ts";
import { getMode, setMode, type Mode } from "../../../mode.ts";
import { useCaptureLog } from "../../../test/lib/stubs.ts";
import { list, wrapText } from "./list.ts";
import { transformers } from "./registry.ts";

const captured = useCaptureLog();

// eslint-disable-next-line no-control-regex
const stripAnsi = (value: string) => value.replace(/\[[0-9;]*m/g, "");

let workDir: string;
let originalCwd: string;

beforeAll(() => {
  originalCwd = process.cwd();
  workDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "clerk-migrate-tlist-")));
  process.chdir(workDir);
  fs.writeFileSync(
    path.join(workDir, "custom.ts"),
    `export default {
      key: "myplatform",
      label: "My Platform",
      description: "Exports from My Platform.",
      transformer: { account_ref: "userId" },
    };`,
  );
});

afterAll(() => {
  process.chdir(originalCwd);
  fs.rmSync(workDir, { recursive: true, force: true });
});

describe("human output", () => {
  test.each([...transformers])("lists the $key transformer with its label", async (transformer) => {
    await list();
    expect(captured.err).toContain(transformer.key);
    expect(captured.err).toContain(transformer.label);
  });

  // Two normalizations: `log.info` auto-highlights backticked spans, so the
  // rendered description carries colour codes the source string does not, and
  // descriptions are wrapped to the terminal width across several indented
  // lines. Collapsing whitespace compares the words, not the layout.
  const collapse = (value: string) => stripAnsi(value).replace(/\s+/g, " ");

  test.each([...transformers])("includes the $key description", async (transformer) => {
    await list();
    expect(collapse(captured.err)).toContain(collapse(transformer.description));
  });

  test("counts the built-ins", async () => {
    await list();
    expect(captured.err).toContain(`${transformers.length} built-in transformers`);
  });

  // A compiled binary has no source tree to grep, so the way to extend it has
  // to be discoverable from the list itself.
  test("says how to add one when none is loaded", async () => {
    await list();
    expect(captured.err).toContain("--transformer-file");
  });

  test("appends a custom transformer and names its source", async () => {
    await list({ transformerFile: "./custom.ts" });

    expect(captured.err).toContain("myplatform");
    expect(captured.err).toContain("custom — ./custom.ts");
    expect(captured.err).toContain("plus 1 loaded from --transformer-file");
  });

  test("drops the how-to hint once one is loaded", async () => {
    await list({ transformerFile: "./custom.ts" });
    expect(captured.err).not.toContain("Migrating from something else?");
  });
});

describe("--json", () => {
  test("emits every built-in on stdout", async () => {
    await list({ json: true });

    const parsed = JSON.parse(captured.out) as Record<string, unknown>[];
    expect(parsed).toHaveLength(transformers.length);
    expect(parsed.map((entry) => entry.key)).toEqual(transformers.map((entry) => entry.key));
  });

  test("reports key, label, description and the userId source field", async () => {
    await list({ json: true });

    const parsed = JSON.parse(captured.out) as Record<string, unknown>[];
    expect(parsed[0]).toMatchObject({
      key: "clerk",
      label: "Clerk",
      built_in: true,
      maps_to_user_id: "id",
    });
  });

  test("marks a custom transformer as not built in", async () => {
    await list({ json: true, transformerFile: "./custom.ts" });

    const parsed = JSON.parse(captured.out) as Record<string, unknown>[];
    expect(parsed.at(-1)).toMatchObject({
      key: "myplatform",
      built_in: false,
      source: "./custom.ts",
      maps_to_user_id: "account_ref",
    });
  });
});

describe("a bad --transformer-file", () => {
  test("fails rather than listing only the built-ins", async () => {
    await expect(list({ transformerFile: "./nope.ts" })).rejects.toThrow(CliError);
  });
});

describe("human-mode frame", () => {
  let originalMode: Mode;

  beforeAll(() => {
    originalMode = getMode();
    setMode("human");
  });

  afterAll(() => {
    setMode(originalMode);
  });

  // Reading a static registry is not a run: there is no progress to bracket,
  // and the gutter's `│` would sit in front of every wrapped line.
  test("prints no intro/outro gutter", async () => {
    await list();

    expect(captured.err).not.toContain("┌");
    expect(captured.err).not.toContain("└");
    expect(stripAnsi(captured.err)).toContain("Transformers:");
  });

  test("--json stays on stdout only", async () => {
    await list({ json: true });

    expect(() => JSON.parse(captured.out)).not.toThrow();
    expect(captured.err).toBe("");
  });
});

describe("wrapText", () => {
  test("breaks on whitespace within the width", () => {
    expect(wrapText("one two three four", 9)).toEqual(["one two", "three", "four"]);
  });

  // `log.info` pairs backticks per line, so a span split across two lines
  // leaves one unmatched backtick on each and colours the wrong half of both.
  test("never breaks inside a backticked span", () => {
    const lines = wrapText("Assumes an export of `SELECT id, name FROM users`.", 30);

    expect(lines).toContain("`SELECT id, name FROM users`.");
    for (const line of lines) {
      expect((line.match(/`/g) ?? []).length % 2).toBe(0);
    }
  });

  test("gives an over-long word its own line rather than dropping it", () => {
    expect(wrapText("short supercalifragilistic", 8)).toEqual(["short", "supercalifragilistic"]);
  });
});
