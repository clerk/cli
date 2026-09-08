import { test, expect } from "bun:test";
import { mkdtemp, cp, rm, realpath } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { parseEnv } from "node:util";
import { gitInit, linkProject } from "./lib/fixture-setup.ts";
import { log } from "./lib/logger.ts";

const FIXTURES_DIR = join(import.meta.dir, "fixtures");
const CLI_PATH = join(import.meta.dir, "../../packages/cli-core/src/cli.ts");

/**
 * Native platforms (iOS, Android) have no package.json, no npm install, and no
 * build CI can run — Xcode and Gradle toolchains aren't available. So instead
 * of the manifest/`createFixtureHarness` flow, this test asserts the whole of
 * what `clerk init` promises on native: platform detection from marker files,
 * keys pulled into `.env`, zero project files written, and the SDK quickstart
 * printed. The fixtures are hand-authored marker stubs the refresh script
 * never touches.
 */
const PLATFORMS = [
  {
    fixture: "ios",
    detectedName: "iOS (Swift)",
    // One stable phrase per printed quickstart step that would break setup if dropped.
    instructions: ["Swift Package Manager", "dashboard.clerk.com/~/native-applications"],
  },
  {
    fixture: "android",
    detectedName: "Android (Kotlin)",
    instructions: ["app/build.gradle.kts", "dashboard.clerk.com/~/native-applications"],
  },
] as const;

test.each([...PLATFORMS])(
  "clerk init on a $fixture project pulls keys and writes nothing else",
  async ({ fixture, detectedName, instructions }) => {
    const platformAPIKey = process.env.CLERK_PLATFORM_API_KEY;
    if (!platformAPIKey) throw new Error("Missing required env var: CLERK_PLATFORM_API_KEY");

    const tmp = await realpath(tmpdir());
    const projectDir = await mkdtemp(join(tmp, `clerk-e2e-${fixture}-`));
    const configDir = await mkdtemp(join(tmp, "clerk-e2e-config-"));

    try {
      await cp(join(FIXTURES_DIR, fixture), projectDir, { recursive: true });
      await gitInit(projectDir);
      await linkProject(projectDir, configDir);

      const result = await Bun.$`bun ${CLI_PATH} --mode human init --yes --no-skills`
        .cwd(projectDir)
        .env({
          CLERK_CONFIG_DIR: configDir,
          CLERK_PLATFORM_API_KEY: platformAPIKey,
          CLERK_TELEMETRY_DISABLED: "1",
        })
        .quiet()
        .nothrow();
      const output = result.stdout.toString() + result.stderr.toString();
      log(`init output:\n${output}`);

      expect(result.exitCode).toBe(0);
      expect(output).toContain(detectedName);
      for (const instruction of instructions) {
        expect(output).toContain(instruction);
      }

      // Keys were pulled into .env (natives configure the publishable key in
      // source, so the quickstart tells users to copy it from here).
      const envFile = Bun.file(join(projectDir, ".env"));
      expect(await envFile.exists()).toBe(true);
      const envVars = parseEnv(await envFile.text()) as Record<string, string>;
      expect(envVars["CLERK_PUBLISHABLE_KEY"]).toStartWith("pk_");
      // Deliberately absent: native apps never use the secret key, and their
      // default .gitignore templates don't cover .env, so pull skips it.
      expect(envVars["CLERK_SECRET_KEY"]).toBeUndefined();

      // Native scaffolding is instruction-only by design: the only thing init
      // may leave behind is the env file. Everything else was committed by
      // gitInit, so any other entry here is an unexpected write.
      const status = await Bun.$`git status --porcelain`.cwd(projectDir).quiet().nothrow();
      const entries = status.stdout
        .toString()
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean);
      expect(entries).toEqual(["?? .env"]);
    } finally {
      await rm(projectDir, { recursive: true, force: true }).catch((err) => log(`rm: ${err}`));
      await rm(configDir, { recursive: true, force: true }).catch((err) => log(`rm: ${err}`));
    }
  },
  { timeout: 120_000 },
);
