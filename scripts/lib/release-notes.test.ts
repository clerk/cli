import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { getStableReleaseCreateArgs } from "./release-notes.ts";

describe("getStableReleaseCreateArgs", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "release-notes-"));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  test("uses plain generated notes when no intro file exists", async () => {
    expect(await getStableReleaseCreateArgs("1.0.0", tempDir)).toEqual({
      args: ["gh", "release", "create", "v1.0.0", "--generate-notes"],
    });
  });

  test("prepends version-specific notes when the intro file exists", async () => {
    const notesPath = join(tempDir, "v1.0.0.md");
    await Bun.write(notesPath, "Intro line\n\n- Highlight");

    expect(await getStableReleaseCreateArgs("1.0.0", tempDir)).toEqual({
      args: [
        "gh",
        "release",
        "create",
        "v1.0.0",
        "--generate-notes",
        "--notes",
        "Intro line\n\n- Highlight",
      ],
      notesPath,
    });
  });

  test("ignores empty intro files", async () => {
    await Bun.write(join(tempDir, "v1.0.0.md"), "\n  \n");

    expect(await getStableReleaseCreateArgs("1.0.0", tempDir)).toEqual({
      args: ["gh", "release", "create", "v1.0.0", "--generate-notes"],
    });
  });
});
