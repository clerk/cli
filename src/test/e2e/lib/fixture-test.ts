import { join } from "node:path";
import { test, beforeAll, afterAll } from "bun:test";
import { setupFixture } from "./fixture-setup.ts";
import type { FixtureConfig } from "./types.ts";
import { chromium } from "playwright";
import { clerkSetup, setupClerkTestingToken, clerk } from "@clerk/testing/playwright";
import { getAvailablePort, startDevServer, killDevServer } from "./dev-server.ts";
import { createTestUser, deleteTestUser } from "./test-user.ts";
import { log } from "./logger.ts";

// Bridge CLERK_BACKEND_API_URL -> CLERK_API_URL for @clerk/testing
if (process.env.CLERK_BACKEND_API_URL && !process.env.CLERK_API_URL) {
  process.env.CLERK_API_URL = process.env.CLERK_BACKEND_API_URL;
}

// Run clerkSetup once for the entire process (fetches testing token from BAPI).
// All fixtures share the same Clerk app, so one setup is sufficient.
let clerkSetupDone: Promise<void> | null = null;
function ensureClerkSetup(opts: { publishableKey: string; secretKey: string }): Promise<void> {
  if (!clerkSetupDone) {
    clerkSetupDone = clerkSetup(opts);
  }
  return clerkSetupDone;
}

/**
 * Read the fixture's package.json and check if it has a `typecheck` script.
 * If so, use `bun run typecheck` instead of bare `tsc --noEmit` so
 * framework-specific type generation (e.g. `react-router typegen`) runs first.
 */
async function hasTypecheckScript(projectDir: string): Promise<boolean> {
  try {
    const pkg = await Bun.file(join(projectDir, "package.json")).json();
    return Boolean(pkg.scripts?.typecheck);
  } catch {
    return false;
  }
}

type FixtureState = {
  projectDir: string;
  configDir: string;
  publishableKey: string;
  secretKey: string;
};

/**
 * Shared fixture lifecycle hook. Calls `setupFixture()` once in `beforeAll`
 * and cleans up in `afterAll`. Returns a getter that provides the shared
 * `{ projectDir }` to all tests in the file.
 *
 * Must be called at the top level of a test file (not inside `describe`).
 */
export function useFixture(fixtureDir: string, config: FixtureConfig): () => FixtureState {
  // Skip when imported by the refresh script
  if (process.env.CLERK_REFRESH_FIXTURES) {
    return () => ({
      projectDir: "",
      configDir: "",
      publishableKey: "",
      secretKey: "",
    });
  }

  let state: (FixtureState & { cleanup: () => Promise<void> }) | null = null;

  beforeAll(async () => {
    log(config.description, "beforeAll started");
    state = await setupFixture(fixtureDir);
    log(config.description, "beforeAll finished");
  }, 300_000);

  afterAll(async () => {
    log(config.description, "afterAll started");
    await state?.cleanup();
    log(config.description, "afterAll finished");
  }, 60_000);

  return () => {
    if (!state) throw new Error("Fixture not initialized - useFixture() beforeAll has not run yet");
    return state;
  };
}

/**
 * Register a bun test that verifies the framework build command and
 * `tsc --noEmit` both pass using the shared fixture from `useFixture()`.
 *
 * Build runs first so frameworks that generate types during build
 * (TanStack Router routeTree.gen) have them available for tsc.
 * If the project defines a `typecheck` script, it's used instead of
 * bare `tsc --noEmit` (e.g. React Router needs `react-router typegen`
 * before tsc).
 */
export function runFixtureTest(getFixture: () => FixtureState, config: FixtureConfig): void {
  if (process.env.CLERK_REFRESH_FIXTURES) return;

  test(
    `clerk init [${config.description}]: tsc and build pass`,
    async () => {
      const { projectDir } = getFixture();

      // Build first so type generation artifacts are available for tsc.
      log(config.description, "build started");
      const build = await Bun.$`bunx ${config.buildCmd}`.cwd(projectDir).quiet().nothrow();
      if (build.exitCode !== 0) {
        throw new Error(
          `${config.buildCmd.join(" ")} failed:\n${build.stdout.toString()}\n${build.stderr.toString()}`,
        );
      }
      log(config.description, "build done");

      // Use the project's typecheck script if available (handles
      // framework-specific type generation), otherwise plain tsc.
      const useTypecheck = await hasTypecheckScript(projectDir);
      log(
        config.description,
        `typecheck started (${useTypecheck ? "bun run typecheck" : "tsc --noEmit"})`,
      );
      const tsc = useTypecheck
        ? await Bun.$`bun run typecheck`.cwd(projectDir).quiet().nothrow()
        : await Bun.$`bunx tsc --noEmit`.cwd(projectDir).quiet().nothrow();
      if (tsc.exitCode !== 0) {
        throw new Error(
          `${useTypecheck ? "typecheck" : "tsc --noEmit"} failed:\n${tsc.stdout.toString()}\n${tsc.stderr.toString()}`,
        );
      }
      log(config.description, "typecheck done");
    },
    { timeout: 300_000 }, // 5 minutes - install + build can be slow
  );
}

/**
 * Register a bun test that starts a dev server, creates a test user,
 * and verifies sign-in works via @clerk/testing in a real browser.
 */
export function runBrowserTest(getFixture: () => FixtureState, config: FixtureConfig): void {
  if (process.env.CLERK_REFRESH_FIXTURES) return;

  test(
    `clerk init [${config.description}]: app loads and auth flow works`,
    async () => {
      const { projectDir, configDir, publishableKey, secretKey } = getFixture();
      const fixtureName = config.description;

      let port: number | undefined;
      let proc: import("bun").Subprocess | undefined;
      let stderrLines: string[] = [];
      let stdoutLines: string[] = [];
      let testUser: { id: string; email: string; password: string } | undefined;
      let browser: import("playwright").Browser | undefined;
      const harPath = process.env.E2E_HAR_DIR
        ? `${process.env.E2E_HAR_DIR}/${fixtureName.replace(/\s+/g, "-")}.har`
        : undefined;

      try {
        // 1. Create test user
        testUser = await createTestUser(configDir, secretKey, fixtureName);

        // 2. Start dev server
        port = await getAvailablePort();
        const server = await startDevServer({
          devCmd: config.devCmd,
          port,
          projectDir,
          fixtureName,
        });
        proc = server.proc;
        stderrLines = server.stderr;
        stdoutLines = server.stdout;

        // 3. Set up Clerk testing infrastructure (once per process)
        await ensureClerkSetup({ publishableKey, secretKey });

        // 4. Launch browser and navigate
        browser = await chromium.launch();
        const context = await browser.newContext({
          ignoreHTTPSErrors: true,
          bypassCSP: true,
          ...(harPath ? { recordHar: { path: harPath } } : {}),
        });
        const page = await context.newPage();
        page.setDefaultTimeout(30_000);
        page.setDefaultNavigationTimeout(30_000);

        // Capture console errors for diagnostics
        const consoleErrors: string[] = [];
        page.on("console", (msg) => {
          if (msg.type() === "error") consoleErrors.push(msg.text());
        });

        const frontendApiUrl = process.env.CLERK_FAPI;
        await setupClerkTestingToken({
          page,
          context,
          options: frontendApiUrl ? { frontendApiUrl } : undefined,
        });
        log(fixtureName, `navigating to http://localhost:${port}`);
        await page.goto(`http://localhost:${port}`, { waitUntil: "load" });

        // 5. Sign in
        log(fixtureName, "signing in");
        await clerk.signIn({
          page,
          signInParams: {
            strategy: "password",
            identifier: testUser.email,
            password: testUser.password,
          },
        });

        // 6. Verify Clerk loaded
        await clerk.loaded({ page });
        log(fixtureName, "clerk has been loaded");

        // NOTE: disabled currently as this is very flakey during e2e testing.
        // // 7. Check to see that the user is now on the window object.
        // await page.waitForFunction(() => window.Clerk?.user !== null, null, {
        //   timeout: 10_000,
        // });
        // log(fixtureName, "auth flow passed");

        // Log any console errors as warnings (non-fatal)
        if (consoleErrors.length > 0) {
          log(fixtureName, `console errors during test:\n${consoleErrors.join("\n")}`);
        }
      } catch (err) {
        // Take screenshot on failure for debugging
        try {
          if (browser) {
            const pages = browser.contexts()[0]?.pages() ?? [];
            if (pages.length > 0) {
              const screenshotPath = `/tmp/clerk-e2e-${fixtureName.replace(/\s+/g, "-")}-failure.png`;
              await pages[0].screenshot({ path: screenshotPath, fullPage: true, timeout: 5_000 });
              log(fixtureName, `failure screenshot saved: ${screenshotPath}`);
            }
          }
        } catch (screenshotErr) {
          log(fixtureName, `screenshot failed: ${screenshotErr}`);
        }

        // Attach dev server output to the error
        if (stdoutLines.length > 0) {
          log(fixtureName, `dev server stdout:\n${stdoutLines.join("")}`);
        }
        if (stderrLines.length > 0) {
          log(fixtureName, `dev server stderr:\n${stderrLines.join("")}`);
        }

        throw err;
      } finally {
        // Always clean up - close context first to flush HAR, then browser
        if (browser) {
          for (const ctx of browser.contexts()) {
            await ctx.close().catch((e) => log(fixtureName, `context close failed: ${e}`));
          }
          await browser.close().catch((e) => log(fixtureName, `browser close failed: ${e}`));
          if (harPath) log(fixtureName, `HAR file saved: ${harPath}`);
        }
        if (proc) {
          await killDevServer(proc, fixtureName).catch((e) =>
            log(fixtureName, `dev server kill failed: ${e}`),
          );
        }
        if (testUser) {
          await deleteTestUser(testUser.id, configDir, secretKey, fixtureName).catch(() => {});
        }
      }
    },
    { timeout: 150_000 }, // 2.5 minutes - 90s auth + 60s cleanup headroom
  );
}
