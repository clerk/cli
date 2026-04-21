import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { getStableReleaseCreateArgs, stableReleaseNotesPath } from "./release-notes.ts";

let tempDir: string | undefined;

afterEach(async () => {
  if (tempDir) {
    await rm(tempDir, { recursive: true, force: true });
    tempDir = undefined;
  }
});

describe("stableReleaseNotesPath", () => {
  test("builds the version-specific markdown path", () => {
    expect(stableReleaseNotesPath("1.0.0", "/tmp/release-notes")).toBe(
      "/tmp/release-notes/v1.0.0.md",
    );
  });
});

describe("getStableReleaseCreateArgs", () => {
  test("uses plain generated notes when no intro file exists", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "release-notes-"));

    expect(await getStableReleaseCreateArgs("1.0.0", tempDir)).toEqual([
      "gh",
      "release",
      "create",
      "v1.0.0",
      "--generate-notes",
    ]);
  });

  test("prepends version-specific notes when the intro file exists", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "release-notes-"));
    await Bun.write(join(tempDir, "v1.0.0.md"), "Intro line\n\n- Highlight");

    expect(await getStableReleaseCreateArgs("1.0.0", tempDir)).toEqual([
      "gh",
      "release",
      "create",
      "v1.0.0",
      "--generate-notes",
      "--notes",
      "Intro line\n\n- Highlight",
    ]);
  });

  test("ignores empty intro files", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "release-notes-"));
    await Bun.write(join(tempDir, "v1.0.0.md"), "\n  \n");

    expect(await getStableReleaseCreateArgs("1.0.0", tempDir)).toEqual([
      "gh",
      "release",
      "create",
      "v1.0.0",
      "--generate-notes",
    ]);
  });
});
