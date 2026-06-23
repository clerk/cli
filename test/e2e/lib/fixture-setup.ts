import { mkdtemp, cp, rm, realpath } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { parseEnv } from "node:util";
// NOTE: These helpers are imported from the CLI source (the SUT). This couples
// the test to the product code for env var name detection. We accept this
// trade-off because the detection logic is stable and the alternative
// (hardcoding per-framework env var names in each fixture config) adds
// maintenance burden without meaningfully improving test independence.
import {
  detectPublishableKeyName,
  detectSecretKeyName,
} from "../../../packages/cli-core/src/lib/framework.ts";
import { fixtures, type FixtureName } from "../fixtures.manifest.ts";
import type { FixtureConfig } from "./types.ts";
import { log } from "./logger.ts";

const FIXTURES_DIR = join(import.meta.dir, "..", "fixtures");
// Path to CLI entry point relative to this file (test/e2e/lib/ -> packages/cli-core/src/cli.ts)
const CLI_PATH = join(import.meta.dir, "../../../packages/cli-core/src/cli.ts");

function requireEnv(name: string): string {
  const val = process.env[name];
  if (!val) throw new Error(`Missing required env var: ${name}. Set it before running e2e tests.`);
  return val;
}

/** Throw with a descriptive message if a shell command failed. */
function assertSuccess(
  label: string,
  result: { exitCode: number; stderr: { toString(): string } },
): void {
  if (result.exitCode !== 0) {
    throw new Error(`${label}:\n${result.stderr.toString()}`);
  }
}

/**
 * Copy the fixture directory into an existing project dir.
 */
async function copyFixture(fixtureDir: string, projectDir: string): Promise<void> {
  await cp(fixtureDir, projectDir, { recursive: true });
}

/**
 * npm's default fetch-timeout is 300s, so one stalled registry connection in
 * `clerk init`'s SDK install or `npm ci` can consume the entire 300s beforeAll
 * budget. Cap it low so a stalled fetch aborts fast and retries on a fresh
 * connection — and stays well under the withRetry step budgets. Both npm runs
 * use projectDir as cwd, so a project-level `.npmrc` covers them.
 */
async function writeNpmrc(projectDir: string): Promise<void> {
  await Bun.write(
    join(projectDir, ".npmrc"),
    "fetch-timeout=20000\nfetch-retries=2\nfetch-retry-mintimeout=1000\nfetch-retry-maxtimeout=8000\n",
  );
}

/**
 * Best-effort recursive remove. Cleanup runs after the test has already
 * passed, so a stray filesystem error here must not fail the test. Bun's
 * node:fs/promises is known to surface transient EFAULT from rm under
 * concurrent load (oven-sh/bun#28958, #9298); the OS reclaims /tmp anyway.
 */
async function safeRm(path: string): Promise<void> {
  try {
    await rm(path, { recursive: true, force: true });
  } catch (err) {
    log(`rm failed for ${path}: ${err}`);
  }
}

/**
 * Run a step with a hard timeout, retrying once on a fresh subprocess. In human
 * mode `clerk link`/`clerk init` shell out to git and can intermittently stall
 * in a non-fetch path (a git subprocess, a prompt) that the CLI's own request
 * timeout doesn't bound — which would otherwise burn the whole 300s beforeAll
 * budget. Promise.race abandons a hung subprocess (no stream deadlock), and the
 * retry lands on a clean run; beforeAll is not retried, so a brief orphan can't
 * cascade.
 */
async function withRetry(label: string, timeoutMs: number, fn: () => Promise<void>): Promise<void> {
  for (let attempt = 1; attempt <= 2; attempt++) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`${label} timed out after ${timeoutMs}ms`)),
        timeoutMs,
      );
    });
    try {
      await Promise.race([fn(), timeout]);
      return;
    } catch (err) {
      if (attempt === 2) throw err;
      log(`${label} attempt ${attempt} failed (${err}); retrying`);
    } finally {
      clearTimeout(timer);
    }
  }
}

/**
 * Pre-link the project to the test Clerk application using an isolated
 * CLERK_CONFIG_DIR, so `clerk init` finds an existing link and skips the
 * interactive app picker.
 */
async function linkProject(projectDir: string, configDir: string): Promise<void> {
  const appId = requireEnv("CLERK_CLI_TEST_APP_ID");
  const platformAPIKey = requireEnv("CLERK_PLATFORM_API_KEY");

  const result = await Bun.$`bun ${CLI_PATH} --mode human link --app ${appId}`
    .cwd(projectDir)
    .env({
      CLERK_CONFIG_DIR: configDir,
      CLERK_PLATFORM_API_KEY: platformAPIKey,
    })
    .quiet()
    .nothrow();

  assertSuccess("clerk link failed", result);
}

async function gitInit(projectDir: string): Promise<void> {
  const result =
    await Bun.$`git -c commit.gpgsign=false init && git add -A && git -c commit.gpgsign=false commit -m "init" --allow-empty`
      .cwd(projectDir)
      .env({
        ...process.env,
        GIT_AUTHOR_NAME: "test",
        GIT_AUTHOR_EMAIL: "test@test.com",
        GIT_COMMITTER_NAME: "test",
        GIT_COMMITTER_EMAIL: "test@test.com",
      })
      .quiet()
      .nothrow();

  assertSuccess("git init failed", result);
}

/**
 * Run `clerk init --yes --no-skills` against the project directory using the
 * pre-linked config. Skills install is skipped to avoid polluting the project
 * with skill template files that break framework typecheck.
 */
async function runClerkInit(projectDir: string, configDir: string): Promise<void> {
  const platformAPIKey = requireEnv("CLERK_PLATFORM_API_KEY");

  const result = await Bun.$`bun ${CLI_PATH} --mode human init --yes --no-skills`
    .cwd(projectDir)
    .env({
      CLERK_CONFIG_DIR: configDir,
      CLERK_PLATFORM_API_KEY: platformAPIKey,
    })
    .quiet()
    .nothrow();

  assertSuccess("clerk init failed", result);
}

/** Parse env files written by clerk init into a merged Record<string, string>.
 *  Reads both .env.local and .env since the target depends on the framework. */
async function parseEnvFiles(projectDir: string): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  for (const name of [".env", ".env.local"]) {
    const file = Bun.file(join(projectDir, name));
    if (await file.exists()) {
      Object.assign(result, parseEnv(await file.text()));
    }
  }
  if (Object.keys(result).length === 0) {
    throw new Error(
      `No .env or .env.local found in ${projectDir}. Did clerk init run successfully?`,
    );
  }
  return result;
}

export type Fixture = {
  name: FixtureName;
  config: FixtureConfig;
  fixtureDir: string;
  projectDir: string;
  configDir: string;
  publishableKey: string;
  secretKey: string;
  cleanup: () => Promise<void>;
};

/**
 * Shared setup: look up the fixture in the manifest, copy it to a temp dir,
 * pre-link, run clerk init, npm ci. Returns a `Fixture` that embeds the
 * resolved config and fixtureDir so downstream helpers don't need to thread
 * them separately.
 */
export async function setupFixture(name: FixtureName): Promise<Fixture> {
  const config = fixtures[name];
  const fixtureDir = join(FIXTURES_DIR, name);

  // Resolve symlinks (macOS /var -> /private/var) so profile keys match across commands
  const tmp = await realpath(tmpdir());
  const projectDir = await mkdtemp(join(tmp, `clerk-e2e-${name}-`));
  const configDir = await mkdtemp(join(tmp, "clerk-e2e-config-"));
  await copyFixture(fixtureDir, projectDir);
  await writeNpmrc(projectDir);
  log("fixture copied");

  let publishableKey = "";
  let secretKey = "";

  try {
    // Git-init before linking so the profile key matches for later commands.
    // Step markers are debug-gated (CLERK_E2E_DEBUG) and pinpoint which step
    // stalls if setup ever hits the 300s beforeAll budget.
    await withRetry("git init", 30_000, () => gitInit(projectDir));
    log("git init done");
    // Budgets sit above loggedFetch's 60s request timeout so a genuinely slow
    // API call is handled there; withRetry only trips on a non-fetch stall.
    await withRetry("clerk link", 90_000, () => linkProject(projectDir, configDir));
    log("clerk link done");
    await withRetry("clerk init", 120_000, () => runClerkInit(projectDir, configDir));
    log("clerk init done");

    const envVars = await parseEnvFiles(projectDir);

    const publishableKeyName = await detectPublishableKeyName(projectDir);
    publishableKey = envVars[publishableKeyName] ?? "";
    if (!publishableKey) {
      throw new Error(`${publishableKeyName} not found in env files written by clerk init.`);
    }

    const secretKeyName = await detectSecretKeyName(projectDir);
    secretKey = envVars[secretKeyName] ?? "";
    if (!secretKey) {
      throw new Error(`${secretKeyName} not found in env files written by clerk init.`);
    }

    // fetch-timeout/retries come from the project .npmrc (writeNpmrc); --no-audit
    // and --no-fund drop npm's advisory network round-trips during `ci`.
    await withRetry("npm ci", 120_000, async () => {
      const install = await Bun.$`npm ci --ignore-scripts --legacy-peer-deps --no-audit --no-fund`
        .cwd(projectDir)
        .quiet()
        .nothrow();
      assertSuccess("npm ci failed", install);
    });
    log("npm ci done");
  } catch (err) {
    await safeRm(projectDir);
    await safeRm(configDir);
    throw new Error("setup failed", { cause: err });
  }

  const cleanup = async () => {
    await safeRm(projectDir);
    await safeRm(configDir);
  };

  return {
    name,
    config,
    fixtureDir,
    projectDir,
    configDir,
    publishableKey,
    secretKey,
    cleanup,
  };
}
