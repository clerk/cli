import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { fixtures } from "../test/e2e/fixtures.manifest.ts";
import type { FixtureConfig } from "../test/e2e/lib/types.ts";
import { refreshFixtures } from "./refresh-e2e-fixtures.ts";

describe("react-router fixture scaffold command", () => {
  test("disables git initialization", () => {
    expect(fixtures["react-router"].scaffoldCmd).toContain("--no-git-init");
  });
});

describe("refreshFixtures", () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    for (const dir of tempDirs) {
      await rm(dir, { recursive: true, force: true });
    }
    tempDirs.length = 0;
  });

  test("attempts every requested scaffold before reporting failures", async () => {
    const tmpRoot = await mkdtemp(join(tmpdir(), "refresh-fixtures-test-"));
    tempDirs.push(tmpRoot);

    const attempts: string[] = [];
    const errorSpy = spyOn(console, "error").mockImplementation(() => {});
    const logSpy = spyOn(console, "log").mockImplementation(() => {});
    const config = {
      scaffoldCmd: ["fake-scaffold"],
      clerkSdk: "@clerk/react",
      buildCmd: ["fake-build"],
      devCmd: ["fake-dev"],
    } satisfies FixtureConfig;

    try {
      const result = await refreshFixtures({
        entries: [
          ["first", config],
          ["second", config],
        ],
        fixturesDir: join(tmpRoot, "fixtures"),
        tmpRoot,
        runScaffold: async (_command, cwd) => {
          attempts.push(basename(cwd));
          return {
            exitCode: 1,
            stderr: `${basename(cwd)} failed`,
            stdout: "",
          };
        },
      });

      expect(attempts).toHaveLength(2);
      expect(attempts[0]).toStartWith("clerk-fixture-first-");
      expect(attempts[1]).toStartWith("clerk-fixture-second-");
      expect(result.failedFixtures).toEqual(["first", "second"]);
      expect(errorSpy.mock.calls.at(-1)?.[0]).toBe("❌ Fixture refresh failed for: first, second");
    } finally {
      errorSpy.mockRestore();
      logSpy.mockRestore();
    }
  });
});
