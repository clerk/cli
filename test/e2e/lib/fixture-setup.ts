import { mkdtemp, cp, rm, realpath } from "node:fs/promises";
import { join, basename } from "node:path";
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
import { log } from "./logger.ts";
// Path to CLI entry point relative to this file (test/e2e/lib/ -> packages/cli-core/src/cli.ts)
const CLI_PATH = join(import.meta.dir, "../../../packages/cli-core/src/cli.ts");

function requireEnv(name: string): string {
  const val = process.env[name];
  if (!val) throw new Error(`Missing required env var: ${name}. Set it before running e2e tests.`);
  return val;
}

/** Build a shared env object for CLI commands. Requires CLERK_PLATFORM_API_KEY. */
function clerkEnv(configDir?: string): Record<string, string | undefined> {
  if (!process.env.CLERK_PLATFORM_API_KEY) {
    throw new Error(
      "Missing required env var: set CLERK_PLATFORM_API_KEY before running e2e tests.",
    );
  }
  return {
    ...process.env,
    ...(configDir ? { CLERK_CONFIG_DIR: configDir } : {}),
  };
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
 * Pre-link the project to the test Clerk application using an isolated
 * CLERK_CONFIG_DIR, so `clerk init` finds an existing link and skips the
 * interactive app picker.
 */
async function linkProject(projectDir: string, configDir: string): Promise<void> {
  const appId = requireEnv("CLERK_CLI_TEST_APP_ID");

  const result = await Bun.$`bun ${CLI_PATH} --mode human link --app ${appId}`
    .cwd(projectDir)
    .env(clerkEnv(configDir))
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
  const result = await Bun.$`bun ${CLI_PATH} --mode human init --yes --no-skills`
    .cwd(projectDir)
    .env(clerkEnv(configDir))
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

/**
 * Shared setup: copy fixture to temp dir, pre-link, run clerk init, bun install.
 */
export async function setupFixture(fixtureDir: string): Promise<{
  projectDir: string;
  configDir: string;
  publishableKey: string;
  secretKey: string;
  cleanup: () => Promise<void>;
}> {
  const name = basename(fixtureDir);
  log(name, "setup started");
  // Resolve symlinks (macOS /var -> /private/var) so profile keys match across commands
  const tmp = await realpath(tmpdir());
  const projectDir = await mkdtemp(join(tmp, `clerk-e2e-${name}-`));
  const configDir = await mkdtemp(join(tmp, "clerk-e2e-config-"));
  await copyFixture(fixtureDir, projectDir);
  log(name, "fixture copied");

  let publishableKey = "";
  let secretKey = "";

  try {
    // Git-init before linking so the profile key matches for later commands
    await gitInit(projectDir);
    log(name, "git init done");
    await linkProject(projectDir, configDir);
    log(name, "clerk link done");
    await runClerkInit(projectDir, configDir);
    log(name, "clerk init done");

    // Verify clerk init wrote env files and extract keys.
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

    const install = await Bun.$`bun install`.cwd(projectDir).quiet().nothrow();
    assertSuccess("bun install failed", install);
    log(name, "bun install done");
  } catch (err) {
    log(name, `setup FAILED: ${err}`);
    await rm(projectDir, { recursive: true, force: true });
    await rm(configDir, { recursive: true, force: true });
    throw err;
  }

  log(name, "setup complete");

  const cleanup = async () => {
    log(name, "cleanup started");
    await rm(projectDir, { recursive: true, force: true });
    await rm(configDir, { recursive: true, force: true });
    log(name, "cleanup done");
  };

  return { projectDir, configDir, publishableKey, secretKey, cleanup };
}
