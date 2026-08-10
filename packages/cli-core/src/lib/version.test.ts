import { test, expect, describe } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import semver from "semver";
import cliPackage from "../../../cli/package.json";
import { getCurrentVersion, isDevVersion, resolveCliVersion } from "./version.ts";

type CompiledVersions = {
  current: string;
  resolved: string | null;
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
      `import { getCurrentVersion, resolveCliVersion } from ${JSON.stringify(join(import.meta.dir, "version.ts"))};\n` +
        `console.log(JSON.stringify({ current: getCurrentVersion(), resolved: resolveCliVersion() ?? null }));\n`,
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

// ── isDevVersion ──────────────────────────────────────────────────────────────

describe("isDevVersion", () => {
  test("recognizes the bare dev version", () => {
    expect(isDevVersion("0.0.0-dev")).toBe(true);
    expect(isDevVersion("3.0.0-dev")).toBe(true);
  });

  test("recognizes a dev version carrying a commit", () => {
    expect(isDevVersion("3.0.0-dev.20260803.f51f1e4")).toBe(true);
    expect(isDevVersion("3.0.0-dev.20260803.f51f1e4.dirty")).toBe(true);
  });

  test("does not treat stable versions as dev", () => {
    expect(isDevVersion("3.0.0")).toBe(false);
  });

  test("does not treat real prereleases as dev", () => {
    expect(isDevVersion("0.0.2-canary.v20260409211526")).toBe(false);
    expect(isDevVersion("3.1.0-snapshot.abc1234")).toBe(false);
    // A channel that merely starts with the same letters is not the dev channel
    expect(isDevVersion("3.1.0-development.1")).toBe(false);
  });
});

// ── resolveCliVersion ─────────────────────────────────────────────────────────

describe("resolveCliVersion", () => {
  test("returns undefined for the checkout-derived test version", () => {
    expect(resolveCliVersion()).toBeUndefined();
  });
});

// ── getCurrentVersion ─────────────────────────────────────────────────────────

describe("getCurrentVersion", () => {
  const version = getCurrentVersion();

  test("is built on the version packages/cli publishes at", () => {
    expect(version.startsWith(`${cliPackage.version}-dev`)).toBe(true);
  });

  test("classifies as a dev version", () => {
    expect(isDevVersion(version)).toBe(true);
  });

  test("is valid semver, so update-check comparisons can never throw on it", () => {
    expect(semver.valid(version)).not.toBeNull();
  });

  test("sorts below the release it is based on", () => {
    expect(semver.lt(version, cliPackage.version)).toBe(true);
  });

  test("is stable for the lifetime of the process", () => {
    expect(getCurrentVersion()).toBe(version);
  });

  test("carries a YYYYMMDD.<sha> commit segment when run from a git checkout", () => {
    // The suite normally runs from a checkout, but an exported tarball with no
    // .git must still produce a usable version.
    const suffix = version.slice(`${cliPackage.version}-dev`.length);
    expect(suffix === "" || /^\.\d{8}\.[0-9a-fg]+(\.dirty)?$/.test(suffix)).toBe(true);
  });
});

// ── compiled version ──────────────────────────────────────────────────────────

describe("compiled version", () => {
  test("bakes checkout metadata into a local compiled binary", async () => {
    expect(await compileVersionFixture(undefined)).toEqual({
      current: getCurrentVersion(),
      resolved: null,
    });
  });

  test("prefers an explicitly defined release version", async () => {
    expect(await compileVersionFixture("3.1.0")).toEqual({
      current: "3.1.0",
      resolved: "3.1.0",
    });
  });
});
