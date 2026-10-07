import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CliError, EXIT_CODE } from "../../../lib/errors.ts";
import { getMode, setMode, type Mode } from "../../../mode.ts";
import { useCaptureLog } from "../../../test/lib/stubs.ts";
import { list, wrapText } from "./list.ts";
import { ACCOUNT_LINKING_URL, sources } from "./registry.ts";

const captured = useCaptureLog();

/** `log.info` highlights backticked spans and the levels are coloured. */
const plain = () => Bun.stripANSI(captured.err).replace(/\s+/g, " ");

let workDir: string;
let originalCwd: string;

beforeAll(() => {
  originalCwd = process.cwd();
  workDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "clerk-migrate-sources-")));
  process.chdir(workDir);
  fs.writeFileSync(
    path.join(workDir, "custom.ts"),
    `export default {
      key: "myplatform",
      label: "My Platform",
      description: "Exports from My Platform.",
      transformer: { account_ref: "userId", mail: "email" },
      carries: {
        passwords: { level: "partial", note: "Only for accounts made after 2020." },
        mfa: { level: "no", note: "None." },
        metadata: { level: "yes", note: "All of it." },
      },
    };`,
  );
});

afterAll(() => {
  process.chdir(originalCwd);
  fs.rmSync(workDir, { recursive: true, force: true });
});

describe("sources", () => {
  test.each([...sources])("lists $key with what it carries", async (entry) => {
    await list(undefined);
    const row = plain().match(new RegExp(`${entry.key} (\\w+) (\\w+) (\\w+)`));
    expect(row?.slice(1)).toEqual([
      entry.carries.passwords.level,
      entry.carries.mfa.level,
      entry.carries.metadata.level,
    ]);
  });

  // No social column: every source shares one note.
  test("prints the account-linking note once", async () => {
    await list(undefined);
    expect(captured.err.split(ACCOUNT_LINKING_URL)).toHaveLength(2);
  });

  // A compiled binary has no source tree to grep, so the way to extend it has
  // to be discoverable from the list itself.
  test("says how to add one", async () => {
    await list(undefined);
    expect(captured.err).toContain("--source ./my-source.ts");
  });

  test("--json lists every built-in with its carries on stdout", async () => {
    await list(undefined, { json: true });

    const parsed = JSON.parse(captured.out) as {
      sources: { key: string; carries: unknown }[];
      account_linking: string;
    };
    expect(parsed.sources.map((entry) => entry.key)).toEqual(sources.map((entry) => entry.key));
    expect(parsed.sources[0]?.carries).toEqual(sources[0]?.carries);
    expect(parsed.account_linking).toContain(ACCOUNT_LINKING_URL);
  });
});

describe("sources <source>", () => {
  test("shows where each field lands, how to export, and what comes across", async () => {
    await list("supabase");

    expect(plain()).toContain("Export with `clerk migrate export supabase`");
    expect(plain()).toContain("encrypted_password → password");
    expect(plain()).toContain("Passwords yes");
    expect(plain()).toContain("passwordHasher is always");
    expect(captured.err).toContain(ACCOUNT_LINKING_URL);
  });

  test("shows a source you wrote, by its path", async () => {
    await list("./custom.ts");

    expect(plain()).toContain("myplatform My Platform (custom — ./custom.ts)");
    expect(plain()).toContain("mail → email");
    expect(plain()).toContain("Only for accounts made after 2020.");
  });

  test("--json returns the detail on stdout", async () => {
    await list("auth0", { json: true });

    expect(JSON.parse(captured.out)).toMatchObject({
      key: "auth0",
      export_command: "clerk migrate export auth0",
      fields: { user_id: "userId" },
      carries: { passwords: { level: "partial" } },
    });
  });

  test("an unknown source is a usage error naming the valid ones", async () => {
    const error = (await list("okta").catch((caught: unknown) => caught)) as CliError;
    expect(error).toBeInstanceOf(CliError);
    expect(error.exitCode).toBe(EXIT_CODE.USAGE);
    expect(error.message).toContain("Valid sources: clerk, auth0");
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
    await list(undefined);

    expect(captured.err).not.toContain("┌");
    expect(captured.err).not.toContain("└");
  });

  test("--json stays on stdout only", async () => {
    await list(undefined, { json: true });

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
