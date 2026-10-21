import { test, expect, describe, beforeEach, afterEach, mock } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { _setConfigDir } from "../../lib/config.ts";
import {
  credentialStoreStubs,
  libPromptsStubs,
  stubFetch,
  useCaptureLog,
} from "../../test/lib/stubs.ts";
import { setLogLevel } from "../../lib/log.ts";

mock.module("../../lib/credential-store.ts", () => credentialStoreStubs);
mock.module("../../lib/prompts.ts", () => libPromptsStubs);
mock.module("../../lib/spinner.ts", () => ({
  intro: () => {},
  outro: () => {},
  pausedOutro: () => {},
  bar: () => {},
  withSpinner: async (_msg: string, fn: () => Promise<unknown>) => fn(),
}));

const { applyConfigPatch } = await import("./apply-patch.ts");

describe("applyConfigPatch", () => {
  const captured = useCaptureLog();
  const originalEnv = { ...process.env };
  const originalFetch = globalThis.fetch;

  let tempDir = "";

  beforeEach(async () => {
    // Keeps the CLI's config reads off the developer's real config file.
    tempDir = await mkdtemp(join(tmpdir(), "clerk-apply-patch-test-"));
    _setConfigDir(tempDir);
    process.env.CLERK_PLATFORM_API_KEY = "test_key";
    process.env.CLERK_PLATFORM_API_URL = "https://test-api.clerk.com";
  });

  afterEach(async () => {
    setLogLevel("info");
    _setConfigDir(undefined);
    await rm(tempDir, { recursive: true, force: true });
    process.env = { ...originalEnv };
    globalThis.fetch = originalFetch;
  });

  // `--verbose` output goes wherever an agent's or CI job's stderr goes, so a
  // credential Clerk echoes back in the write's response must not appear.
  test("redacts secrets in the response it logs under --verbose", async () => {
    stubFetch(async (_input, init) => {
      const isGet = !init?.method || init.method === "GET";
      const body = isGet
        ? { connection_oauth_google: { enabled: false } }
        : {
            connection_oauth_google: {
              enabled: true,
              client_id: "client.apps.googleusercontent.com",
              client_secret: "FAKE_OAUTH_SECRET",
            },
          };
      return new Response(JSON.stringify(body), { status: 200 });
    });
    setLogLevel("debug");

    await applyConfigPatch({
      target: {
        kind: "account",
        ctx: {
          appId: "app_1",
          appLabel: "app",
          instanceId: "ins_dev",
          instanceLabel: "development",
        },
        label: "development",
      },
      payload: { connection_oauth_google: { enabled: true, client_secret: "FAKE_OAUTH_SECRET" } },
      verb: "Updating",
      successMessage: "Updated",
      failureContext: "Failed to update",
      yes: true,
    });

    expect(captured.err).toContain('config: {"connection_oauth_google":{"enabled":true');
    expect(captured.err).toContain('"client_secret":"[REDACTED]"');
    expect(captured.err).not.toContain("FAKE_OAUTH_SECRET");
  });
});
