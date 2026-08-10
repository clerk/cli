import { test, expect, describe } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import semver from "semver";
import cliPackage from "../../../cli/package.json";
import { CURRENT_VERSION, IS_DEV_BUILD } from "./version.ts";

type CompiledVersions = {
  current: string;
  isDev: boolean;
};

async function compileVersionFixture(version: string | undefined): Promise<CompiledVersions> {
  const directory = mkdtempSync(join(tmpdir(), "clerk-version-test-"));
  const entrypoint = join(directory, "version-fixture.ts");
  const executable = join(
    directory,
    process.platform === "win32" ? "version-fixture.exe" : "version-fixture",
  );

  try {
    await Bun.write(
      entrypoint,
      `import { CURRENT_VERSION, IS_DEV_BUILD } from ${JSON.stringify(join(import.meta.dir, "version.ts"))};\n` +
        `console.log(JSON.stringify({ current: CURRENT_VERSION, isDev: IS_DEV_BUILD }));\n`,
    );

    const buildArgs = [process.execPath, "build", "--compile"];
    if (version) {
      buildArgs.push("--define", `CLI_VERSION=${JSON.stringify(version)}`);
    }
    buildArgs.push(entrypoint, "--outfile", executable);

    const build = Bun.spawnSync(buildArgs, { stdio: ["ignore", "pipe", "pipe"] });
    if (build.exitCode !== 0) {
      throw new Error(`Failed to compile version fixture: ${build.stderr.toString().trim()}`);
    }

    const run = Bun.spawnSync([executable], {
      env: { ...process.env, PATH: "" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    if (run.exitCode !== 0) {
      throw new Error(`Failed to run version fixture: ${run.stderr.toString().trim()}`);
    }

    return JSON.parse(run.stdout.toString()) as CompiledVersions;
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

// ── IS_DEV_BUILD ───────────────────────────────────────────────────────────────

describe("IS_DEV_BUILD", () => {
  test("is true for the checkout-derived test version", () => {
    expect(IS_DEV_BUILD).toBe(true);
  });
});

// ── CURRENT_VERSION ────────────────────────────────────────────────────────────

describe("CURRENT_VERSION", () => {
  test("is built on the version packages/cli publishes at", () => {
    expect(CURRENT_VERSION.startsWith(`${cliPackage.version}-dev`)).toBe(true);
  });

  test("is valid semver, so update-check comparisons can never throw on it", () => {
    expect(semver.valid(CURRENT_VERSION)).not.toBeNull();
  });

  test("sorts below the release it is based on", () => {
    expect(semver.lt(CURRENT_VERSION, cliPackage.version)).toBe(true);
  });

  test("carries a YYYYMMDD.<sha> commit segment when run from a git checkout", () => {
    // The suite normally runs from a checkout, but an exported tarball with no
    // .git must still produce a usable version.
    const suffix = CURRENT_VERSION.slice(`${cliPackage.version}-dev`.length);
    expect(suffix === "" || /^\.\d{8}\.[0-9a-fg]+(\.dirty)?$/.test(suffix)).toBe(true);
  });
});

// ── compiled version ──────────────────────────────────────────────────────────

describe("compiled version", () => {
  test("bakes checkout metadata into a local compiled binary", async () => {
    expect(await compileVersionFixture(undefined)).toEqual({
      current: CURRENT_VERSION,
      isDev: true,
    });
  });

  test("prefers an explicitly defined release version", async () => {
    expect(await compileVersionFixture("3.1.0")).toEqual({
      current: "3.1.0",
      isDev: false,
    });
  });

  test("treats an explicitly defined dev version as unversioned", async () => {
    const version = "3.0.0-dev.20260803.f51f1e4";
    expect(await compileVersionFixture(version)).toEqual({
      current: version,
      isDev: true,
    });
  });

  test("keeps an explicitly defined canary version versioned", async () => {
    const version = "0.0.2-canary.v20260409211526";
    expect(await compileVersionFixture(version)).toEqual({
      current: version,
      isDev: false,
    });
  });
});
