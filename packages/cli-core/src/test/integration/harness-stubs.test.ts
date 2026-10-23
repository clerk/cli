/**
 * The harness stands in for the browser and for the process exit code.
 *
 * Tests that walk through sign-in or open a claim page must never launch the
 * developer's browser, and a command that reports failure by setting
 * `process.exitCode` and returning must read as that failure — without leaking
 * it into the next run or the next test.
 */

import { describe, test, expect } from "bun:test";
import {
  clerk,
  getInstance,
  http,
  MOCK_APP,
  MOCK_APP_DEV_ONLY,
  mockState,
  openedUrls,
  setProfile,
  setupTest,
  teardownTest,
  useIntegrationTestHarness,
} from "./lib/harness.ts";

const bunOverrides = Bun as unknown as { spawn: (...args: unknown[]) => unknown };

describe("browser launcher", () => {
  useIntegrationTestHarness();

  // Credentials: none. No stored session and no CLERK_PLATFORM_API_KEY, so
  // login runs the full browser sign-in.
  test("signed-out `clerk auth login` records the authorize URL and launches nothing", async () => {
    mockState.storedToken = null;
    delete process.env.CLERK_PLATFORM_API_KEY;
    // Login's first-application check lists the new account's apps.
    http.mock({ "/v1/platform/applications": [MOCK_APP] });

    const originalSpawn = Bun.spawn;
    const spawned: unknown[] = [];
    bunOverrides.spawn = (...args: unknown[]) => {
      spawned.push(args);
      throw new Error("Bun.spawn called during a harness test");
    };
    try {
      const result = await clerk("auth", "login");

      expect(result.stderr).toContain("Logged in as test@example.com");
      expect(openedUrls).toHaveLength(1);
      const authorizeUrl = new URL(openedUrls[0]!);
      expect(authorizeUrl.pathname).toBe("/oauth/authorize");
      expect(authorizeUrl.searchParams.get("state")).toBe("mock_state");
      // The stub answered, so the real launcher never spawned a browser.
      expect(spawned).toHaveLength(0);
    } finally {
      bunOverrides.spawn = originalSpawn as typeof bunOverrides.spawn;
    }
  });

  test("a test can make the launcher report failure", async () => {
    mockState.storedToken = null;
    delete process.env.CLERK_PLATFORM_API_KEY;
    mockState.openBrowserResult = { ok: false, reason: "no-launcher" };
    http.mock({ "/v1/platform/applications": [MOCK_APP] });

    const result = await clerk("auth", "login");

    expect(openedUrls).toHaveLength(1);
    expect(result.stderr).toContain("Could not open your browser automatically");
  });
});

describe("soft exit codes", () => {
  useIntegrationTestHarness();

  // `deploy status` on an app with no production instance reports the deploy
  // as not started by setting process.exitCode = 1 and returning.
  async function linkDevelopmentOnlyApp() {
    await setProfile("github.com/test/project", {
      workspaceId: "",
      appId: MOCK_APP_DEV_ONLY.application_id,
      instances: { development: getInstance(MOCK_APP_DEV_ONLY, "development").instance_id },
    });
    http.mock({ [`/applications/${MOCK_APP_DEV_ONLY.application_id}`]: MOCK_APP_DEV_ONLY });
  }

  test("a command that sets process.exitCode and returns reads as that exit code", async () => {
    await linkDevelopmentOnlyApp();

    const result = await clerk.raw("deploy", "status");

    expect(result.exitCode).toBe(1);
  });

  test("the next run in the same test starts at exit code 0", async () => {
    await linkDevelopmentOnlyApp();
    const unfinished = await clerk.raw("deploy", "status");
    expect(unfinished.exitCode).toBe(1);

    const next = await clerk.raw("webhooks", "token", "--json");

    expect(next.exitCode).toBe(0);
    expect(Number(process.exitCode ?? 0)).toBe(0);
  });
});

// Calls setupTest/teardownTest directly, so it can observe the process between
// two tests the way the test runner would.
describe("between tests", () => {
  test("a soft exit code one test leaves behind doesn't reach the next test", async () => {
    const first = await setupTest();
    process.exitCode = 1;
    await teardownTest(first);
    expect(Number(process.exitCode ?? 0)).toBe(0);

    // Set outside any harness lifecycle, as a test file's own code might.
    process.exitCode = 1;
    const second = await setupTest();
    try {
      expect(Number(process.exitCode ?? 0)).toBe(0);
    } finally {
      await teardownTest(second);
    }
  });
});
