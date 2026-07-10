import { test, expect, describe, beforeEach, afterEach, spyOn, mock } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { _setConfigDir, setProfile } from "../../lib/config.ts";
import { credentialStoreStubs, gitStubs, stubFetch, useCaptureLog } from "../../test/lib/stubs.ts";

mock.module("../../lib/credential-store.ts", () => credentialStoreStubs);
mock.module("../../lib/git.ts", () => gitStubs);
mock.module("../../lib/spinner.ts", () => ({
  intro: () => {},
  outro: () => {},
  pausedOutro: () => {},
  bar: () => {},
  formatTargetSuffix: (label?: string) => (label ? ` · on ${label}` : ""),
  withGutter: async (
    _title: string,
    fn: (controls: { setNextSteps: (steps: readonly string[]) => void }) => Promise<unknown>,
  ) => fn({ setNextSteps: () => {} }),
  withSpinner: async (_msg: string, fn: () => Promise<unknown>) => fn(),
}));

const { pull } = await import("./pull.ts");

describe("env pull --branch", () => {
  const originalEnv = { ...process.env };
  const originalFetch = globalThis.fetch;
  let tempDir: string;
  let errorSpy: ReturnType<typeof spyOn>;
  let logSpy: ReturnType<typeof spyOn>;
  const captured = useCaptureLog();

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "clerk-env-pull-branch-test-"));
    _setConfigDir(tempDir);
    process.env.CLERK_PLATFORM_API_KEY = "test_key";
    process.env.CLERK_PLATFORM_API_URL = "https://test-api.clerk.com";

    await Bun.write(
      join(tempDir, "package.json"),
      JSON.stringify({ dependencies: { express: "4.0.0" } }),
    );
    await setProfile(tempDir, {
      workspaceId: "org_1",
      appId: "app_1",
      instances: { development: "ins_dev", production: "ins_prod" },
    });

    errorSpy = spyOn(console, "error").mockImplementation(() => {});
    logSpy = spyOn(console, "log").mockImplementation(() => {});
    stubFetch(async () =>
      Response.json({
        application_id: "app_1",
        instances: [
          {
            instance_id: "ins_dev",
            environment_type: "development",
            publishable_key: "pk_test_dev",
            secret_key: "sk_test_dev",
          },
          {
            instance_id: "ins_branch",
            environment_type: "development",
            publishable_key: "pk_test_branch",
            secret_key: "sk_test_branch",
            branch_name: "agent/pr-42",
            parent_instance_id: "ins_dev",
          },
        ],
      }),
    );
  });

  afterEach(async () => {
    _setConfigDir(undefined);
    process.env = { ...originalEnv };
    globalThis.fetch = originalFetch;
    errorSpy.mockRestore();
    logSpy.mockRestore();
    await rm(tempDir, { recursive: true, force: true });
  });

  test("writes keys from the named branch instance", async () => {
    await pull({ branch: "agent/pr-42", cwd: tempDir });

    const content = await Bun.file(join(tempDir, ".env.local")).text();
    expect(content).toContain("CLERK_PUBLISHABLE_KEY=pk_test_branch");
    expect(content).toContain("CLERK_SECRET_KEY=sk_test_branch");
    expect(content).not.toContain("pk_test_dev");
    expect(captured.err).toContain("Environment variables written to .env.local");
  });
});
