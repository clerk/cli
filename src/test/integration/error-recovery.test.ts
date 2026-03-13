/**
 * Recover from errors gracefully
 * CLI provides helpful error messages for common failure modes.
 */

import { test, expect, describe } from "bun:test";
import { join } from "node:path";
import {
  useIntegrationTestHarness,
  http,
  setProfile,
  parseEnvFile,
  clerk,
  getInstance,
  MOCK_APP,
  MOCK_APP_DEV_ONLY,
} from "../lib/setup.ts";

const h = useIntegrationTestHarness();

describe("Recover from errors gracefully", () => {
  // TODO: Add agent mode coverage once `link` performs actual work in agent mode.
  // Currently `link` in agent mode only prints a prompt without linking, so the
  // "link -> env pull" recovery flow cannot be tested in agent mode.
  test("no profile -> link -> API error -> retry success (human mode)", async () => {
    await Bun.write(
      join(h.tempDir, "package.json"),
      JSON.stringify({ name: "test", dependencies: { next: "15.0.0" } }),
    );

    // No profile -> env pull fails
    const { stderr: noProfileErr, exitCode: noProfileExit } = await clerk.raw(
      "--mode",
      "human",
      "env",
      "pull",
    );
    expect(noProfileExit).toBe(1);
    expect(noProfileErr).toContain("No Clerk project linked");

    const devInstance = getInstance(MOCK_APP, "development");

    // Link the project
    http.mock({
      [`/applications/${MOCK_APP.application_id}`]: MOCK_APP,
    });
    await clerk("--mode", "human", "link", "--app", MOCK_APP.application_id);

    // API returns 500
    http.stub(async () => {
      return new Response("Internal Server Error", { status: 500 });
    });

    const { stderr: apiErr, exitCode: apiExit } = await clerk.raw("--mode", "human", "env", "pull");
    expect(apiExit).toBe(1);
    expect(apiErr).toContain("Failed to fetch API keys");

    // Retry with working API
    http.mock({
      [`/applications/${MOCK_APP.application_id}`]: MOCK_APP,
    });
    await clerk("--mode", "human", "env", "pull");
    const env = parseEnvFile(await Bun.file(join(h.tempDir, ".env.local")).text(), ".env.local");
    expect(env.get("NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY")).toBe(devInstance.publishable_key);
    expect(env.get("CLERK_SECRET_KEY")).toBe(devInstance.secret_key);
  });

  test.each([{ mode: "human" }, { mode: "agent" }])(
    "profile has only dev instance -> prod pull fails ($mode mode)",
    async ({ mode }) => {
      const devInstance = getInstance(MOCK_APP_DEV_ONLY, "development");

      await setProfile("github.com/test/project", {
        workspaceId: "",
        appId: MOCK_APP_DEV_ONLY.application_id,
        instances: { development: devInstance.instance_id },
      });

      const { stderr, exitCode } = await clerk.raw(
        "--mode",
        mode,
        "env",
        "pull",
        "--instance",
        "prod",
      );
      expect(exitCode).toBe(1);
      expect(stderr).toContain("No production instance configured");
    },
  );
});
