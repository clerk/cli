import { join } from "node:path";
import { test, expect, beforeAll, afterAll, afterEach } from "bun:test";
import { setupFixture, type Fixture } from "./fixture-setup.ts";
import type { FixtureName } from "../fixtures.manifest.ts";
import { chromium } from "playwright";
import { clerkSetup, setupClerkTestingToken, clerk } from "@clerk/testing/playwright";
import { startDevServer, killDevServer } from "./dev-server.ts";
import {
  createTestUser as baseCreateTestUser,
  deleteTestUser as baseDeleteTestUser,
  type TestUser,
} from "./test-user.ts";
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
    clerkSetupDone = clerkSetup({
      ...opts,
      // We do our own environment loading so we can test out our own
      // expectations for how it behaves with the CLI.
      dotenv: false,
    });
  }
  return clerkSetupDone;
}

/**
 * Read the fixture's package.json and check if it has a `typecheck` script.
 * If so, use `npm run typecheck` instead of bare `bunx tsc --noEmit` so
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

type Users = {
  create: () => Promise<TestUser>;
  delete: (userId: string) => Promise<void>;
  cleanup: () => Promise<void>;
};

type FixtureUsers = Omit<Users, "cleanup">;

function createUsers(fixture: Fixture): Users {
  const createdUserIDs = new Set<string>();

  return {
    create: async () => {
      const user = await baseCreateTestUser(fixture.configDir, { secretKey: fixture.secretKey });
      createdUserIDs.add(user.id);
      return user;
    },
    delete: async (userID) => {
      createdUserIDs.delete(userID);
      await baseDeleteTestUser(userID, fixture.configDir, { secretKey: fixture.secretKey });
    },
    cleanup: async () => {
      if (createdUserIDs.size === 0) return;
      const ids = Array.from(createdUserIDs);
      createdUserIDs.clear();
      await Promise.all(
        ids.map((id) =>
          baseDeleteTestUser(id, fixture.configDir, { secretKey: fixture.secretKey }).catch((err) =>
            log(`afterEach delete failed for ${id}: ${err}`),
          ),
        ),
      );
    },
  };
}

type FixtureHarness = () => {
  fixture: Omit<Fixture, "cleanup">;
  users: FixtureUsers;
};

/**
 * Shared fixture lifecycle hook. Calls `setupFixture(name)` once in
 * `beforeAll` (which looks up the manifest entry and embeds `config` +
 * `fixtureDir` on the returned `Fixture`), cleans up the fixture in
 * `afterAll`, and cleans up per-test users in `afterEach`. Returns a harness
 * that yields `{ fixture, users }` for tests in the file.
 *
 * Must be called at the top level of a `describe(...)` block (not deeper).
 */
export function createFixtureHarness(name: FixtureName): FixtureHarness {
  let fixture: Fixture | null = null;
  let users: Users | null = null;

  beforeAll(async () => {
    fixture = await setupFixture(name);
    users = createUsers(fixture);
  }, 300_000);

  afterEach(async () => {
    await users?.cleanup();
  }, 30_000); // BAPI deletes can exceed bun's 5s default under load; an explicit
  // budget avoids silently orphaning test users when cleanup runs long.

  afterAll(async () => {
    await fixture?.cleanup();
  }, 60_000);

  return () => {
    if (!fixture || !users)
      throw new Error("Fixture not initialized - createFixtureHarness() beforeAll has not run yet");
    return { fixture, users };
  };
}

/**
 * Register a bun test that verifies the framework build command and
 * `tsc --noEmit` both pass using the shared fixture from `createFixtureHarness()`.
 *
 * Build runs first so frameworks that generate types during build
 * (TanStack Router routeTree.gen) have them available for tsc.
 * If the project defines a `typecheck` script, it's used instead of
 * bare `tsc --noEmit` (e.g. React Router needs `react-router typegen`
 * before tsc).
 */
export function runFixtureTests(harness: FixtureHarness): void {
  test(
    "project builds with no errors",
    async () => {
      const { fixture } = harness();
      const { projectDir, config } = fixture;

      // Build first so type generation artifacts are available for tsc.
      const build = await Bun.$`npx ${config.buildCmd}`.cwd(projectDir).quiet().nothrow();
      if (build.exitCode !== 0) {
        throw new Error(
          `${config.buildCmd.join(" ")} failed:\n${build.stdout.toString()}\n${build.stderr.toString()}`,
        );
      }
    },
    { timeout: 300_000 }, // 5 minutes - install + build can be slow)
  );

  test(
    "typecheck passes with no errors",
    async () => {
      const { fixture } = harness();
      const { projectDir } = fixture;

      // Use the project's typecheck script if available (handles
      // framework-specific type generation), otherwise plain tsc.
      const useTypecheck = await hasTypecheckScript(projectDir);
      const command = useTypecheck ? "npm run typecheck" : "bunx tsc --noEmit";
      const shell = useTypecheck
        ? await Bun.$`npm run typecheck 2>&1`.cwd(projectDir).quiet().nothrow()
        : await Bun.$`bunx tsc --noEmit 2>&1`.cwd(projectDir).quiet().nothrow();
      if (shell.exitCode !== 0) {
        throw new Error(`${command} failed in ${projectDir}:\n${shell.text()}`);
      }
    },
    { timeout: 300_000 }, // 5 minutes - install + typecheck can be slow
  );
}

/**
 * Register a bun test that verifies `clerk init` created one of the
 * expected files (e.g. `middleware.ts` or `proxy.ts`) in the project root
 * or `src/` directory.
 *
 * @param expectedFiles - filenames to look for (relative to projectDir).
 *   The test passes if at least one exists.
 */
export function runFileExistsTest(harness: FixtureHarness, expectedFiles: string[]): void {
  const label = expectedFiles.join(" or ");
  test(`\`clerk init\` creates ${label}`, async () => {
    const { fixture } = harness();
    const { projectDir } = fixture;
    const found = await Promise.all(
      expectedFiles.map(async (f) => {
        const file = Bun.file(join(projectDir, f));
        return (await file.exists()) ? f : null;
      }),
    );
    const existing = found.filter(Boolean);
    expect(existing.length).toBeGreaterThanOrEqual(1);
  });
}

/**
 * Register a bun test that starts a dev server, creates a test user,
 * and verifies sign-in works via @clerk/testing in a real browser.
 */
export function runBrowserTests(harness: FixtureHarness): void {
  test(
    "app loads and auth flow works",
    async () => {
      const { fixture, users } = harness();
      const { projectDir, publishableKey, secretKey, config } = fixture;

      let port: number | undefined;
      let host: string | undefined;
      let proc: import("bun").Subprocess | undefined;
      let stderrLines: string[] = [];
      let stdoutLines: string[] = [];
      let testUser: TestUser | undefined;
      let browser: import("playwright").Browser | undefined;
      const harPath = process.env.E2E_HAR_DIR
        ? `${process.env.E2E_HAR_DIR}/${fixture.name.replace(/\s+/g, "-")}.har`
        : undefined;

      try {
        // 1. Create test user
        testUser = await users.create();

        // 2. Start dev server (port is allocated inside, with retries on collision)
        const server = await startDevServer({
          devCmd: config.devCmd,
          projectDir,
        });
        proc = server.proc;
        port = server.port;
        host = server.host;
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
        await page.goto(`http://${host}:${port}`, { waitUntil: "load" });

        // 5. Sign in
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

        // 7. Check to see that the user is now on the window object.
        await page.waitForFunction(
          () => typeof window.Clerk !== "undefined" && window.Clerk.user != null,
          null,
          { timeout: 10_000 },
        );

        // Log any console errors as warnings (non-fatal)
        if (consoleErrors.length > 0) {
          log(`console errors during test:\n${consoleErrors.join("\n")}`);
        }
      } catch (err) {
        // Take screenshot on failure for debugging
        try {
          if (browser) {
            const pages = browser.contexts()[0]?.pages() ?? [];
            if (pages.length > 0) {
              const screenshotPath = `/tmp/clerk-e2e-${fixture.name.replace(/\s+/g, "-")}-failure.png`;
              await pages[0]!.screenshot({
                path: screenshotPath,
                fullPage: true,
                timeout: 5_000,
              });
              log(`failure screenshot saved: ${screenshotPath}`);
            }
          }
        } catch (screenshotErr) {
          log(`screenshot failed: ${screenshotErr}`);
        }

        // Attach dev server output to the error
        if (stdoutLines.length > 0) {
          log(`dev server stdout:\n${stdoutLines.join("")}`);
        }
        if (stderrLines.length > 0) {
          log(`dev server stderr:\n${stderrLines.join("")}`);
        }

        throw err;
      } finally {
        // Always clean up - close context first to flush HAR, then browser
        if (browser) {
          for (const ctx of browser.contexts()) {
            await ctx.close().catch((e) => log(`context close failed: ${e}`));
          }
          await browser.close().catch((e) => log(`browser close failed: ${e}`));
          if (harPath) log(`HAR file saved: ${harPath}`);
        }
        if (proc) {
          await killDevServer(proc).catch((e) => log(`dev server kill failed: ${e}`));
        }
      }
    },
    { timeout: 150_000 }, // 2.5 minutes - 90s auth + 60s cleanup headroom
  );
}
