import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { join } from "node:path";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { runFormatters } from "./format.ts";
import { createFakeSystem } from "../../lib/system.fake.ts";

describe("runFormatters", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "clerk-format-"));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  async function writePackageJson(pkg: object): Promise<void> {
    await writeFile(join(tempDir, "package.json"), JSON.stringify(pkg));
  }

  test("no-op when files is empty", async () => {
    await writePackageJson({ dependencies: { prettier: "3.0.0" } });
    const system = createFakeSystem();
    await runFormatters({ system }, tempDir, []);
    expect(system.calls.runInherit).toHaveLength(0);
  });

  test("no-op when package.json is missing", async () => {
    const system = createFakeSystem();
    await runFormatters({ system }, tempDir, ["a.ts"]);
    expect(system.calls.runInherit).toHaveLength(0);
  });

  test("no-op when no supported formatter is in deps", async () => {
    await writePackageJson({ dependencies: { next: "15.0.0" } });
    const system = createFakeSystem();
    await runFormatters({ system }, tempDir, ["a.ts"]);
    expect(system.calls.runInherit).toHaveLength(0);
  });

  test("runs prettier when in dependencies", async () => {
    await writePackageJson({ dependencies: { prettier: "3.0.0" } });
    const system = createFakeSystem();
    system.queueRunInherit(0);
    await runFormatters({ system }, tempDir, ["src/a.ts", "src/b.ts"]);
    expect(system.calls.runInherit).toEqual([
      {
        cmd: ["prettier", "--ignore-unknown", "--write", "src/a.ts", "src/b.ts"],
        opts: { cwd: tempDir },
      },
    ]);
  });

  test("runs biome when in dependencies", async () => {
    await writePackageJson({ dependencies: { "@biomejs/biome": "1.9.0" } });
    const system = createFakeSystem();
    system.queueRunInherit(0);
    await runFormatters({ system }, tempDir, ["src/a.ts"]);
    expect(system.calls.runInherit).toEqual([
      {
        cmd: ["@biomejs/biome", "format", "--write", "src/a.ts"],
        opts: { cwd: tempDir },
      },
    ]);
  });

  test("runs prettier then biome when both are in deps", async () => {
    await writePackageJson({
      dependencies: { prettier: "3.0.0", "@biomejs/biome": "1.9.0" },
    });
    const system = createFakeSystem();
    system.queueRunInherit(0);
    system.queueRunInherit(0);
    await runFormatters({ system }, tempDir, ["x.ts"]);
    expect(system.calls.runInherit.map((c) => c.cmd)).toEqual([
      ["prettier", "--ignore-unknown", "--write", "x.ts"],
      ["@biomejs/biome", "format", "--write", "x.ts"],
    ]);
  });

  test("detects formatters in devDependencies", async () => {
    await writePackageJson({ devDependencies: { prettier: "3.0.0" } });
    const system = createFakeSystem();
    system.queueRunInherit(0);
    await runFormatters({ system }, tempDir, ["x.ts"]);
    expect(system.calls.runInherit).toHaveLength(1);
  });

  test("continues to next formatter when one exits non-zero", async () => {
    await writePackageJson({
      dependencies: { prettier: "3.0.0", "@biomejs/biome": "1.9.0" },
    });
    const system = createFakeSystem();
    system.queueRunInherit(1);
    system.queueRunInherit(0);
    await runFormatters({ system }, tempDir, ["x.ts"]);
    expect(system.calls.runInherit.map((c) => c.cmd)).toEqual([
      ["prettier", "--ignore-unknown", "--write", "x.ts"],
      ["@biomejs/biome", "format", "--write", "x.ts"],
    ]);
  });
});
