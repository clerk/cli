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

/**
 * Copy the fixture directory into an existing project dir.
 */
async function copyFixture(fixtureDir: string, projectDir: string): Promise<void> {
  await cp(fixtureDir, projectDir, { recursive: true });
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

interface RunStepOptions {
  cwd: string;
  env: Record<string, string | undefined>;
  timeoutMs: number;
}

/**
 * Spawn a setup step, killing the child on timeout so a stall fails fast with a
 * labeled error instead of silently eating the whole 300s `beforeAll` budget.
 */
export async function runStep(label: string, cmd: string[], opts: RunStepOptions): Promise<void> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs);
  const proc = Bun.spawn(cmd, {
    cwd: opts.cwd,
    env: opts.env,
    stdout: "ignore",
    stderr: "pipe",
    signal: controller.signal,
  });
  try {
    const [stderr, exitCode] = await Promise.all([
      new Response(proc.stderr).text().catch(() => ""),
      proc.exited.catch(() => -1),
    ]);
    if (controller.signal.aborted) throw new Error(`${label} timed out after ${opts.timeoutMs}ms`);
    if (exitCode !== 0) throw new Error(`${label} failed:\n${stderr}`);
  } finally {
    clearTimeout(timer);
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

  await runStep("clerk link", ["bun", CLI_PATH, "--mode", "human", "link", "--app", appId], {
    cwd: projectDir,
    // PATH lets Bun.spawn resolve `bun`; the rest of the env stays isolated.
    env: {
      PATH: process.env.PATH,
      CLERK_CONFIG_DIR: configDir,
      CLERK_PLATFORM_API_KEY: platformAPIKey,
    },
    timeoutMs: 60_000,
  });
}

async function gitInit(projectDir: string): Promise<void> {
  await runStep(
    "git init",
    [
      "bash",
      "-c",
      'git -c commit.gpgsign=false init && git add -A && git -c commit.gpgsign=false commit -m "init" --allow-empty',
    ],
    {
      cwd: projectDir,
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "test",
        GIT_AUTHOR_EMAIL: "test@test.com",
        GIT_COMMITTER_NAME: "test",
        GIT_COMMITTER_EMAIL: "test@test.com",
      },
      timeoutMs: 60_000,
    },
  );
}

/**
 * Run `clerk init --yes --no-skills` against the project directory using the
 * pre-linked config. Skills install is skipped to avoid polluting the project
 * with skill template files that break framework typecheck.
 */
async function runClerkInit(projectDir: string, configDir: string): Promise<void> {
  const platformAPIKey = requireEnv("CLERK_PLATFORM_API_KEY");

  await runStep(
    "clerk init",
    ["bun", CLI_PATH, "--mode", "human", "init", "--yes", "--no-skills"],
    {
      cwd: projectDir,
      env: {
        PATH: process.env.PATH,
        CLERK_CONFIG_DIR: configDir,
        CLERK_PLATFORM_API_KEY: platformAPIKey,
      },
      timeoutMs: 90_000,
    },
  );
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

  let publishableKey = "";
  let secretKey = "";

  try {
    // Git-init before linking so the profile key matches for later commands
    await gitInit(projectDir);
    await linkProject(projectDir, configDir);
    await runClerkInit(projectDir, configDir);

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

    await runStep(
      "npm ci",
      ["npm", "ci", "--ignore-scripts", "--legacy-peer-deps", "--no-audit", "--no-fund"],
      { cwd: projectDir, env: process.env, timeoutMs: 240_000 },
    );
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
