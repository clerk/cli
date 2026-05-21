import { test, expect, describe, beforeEach, afterEach, spyOn } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join, basename } from "node:path";
import { tmpdir } from "node:os";
import { stubFetch, useCaptureLog } from "../test/lib/stubs.ts";

import * as autolinkMod from "./autolink.ts";
import * as keylessMod from "./keyless.ts";
import * as pullMod from "../commands/env/pull.ts";
import type { Profile } from "./config.ts";
import { attemptAutoclaim } from "./autoclaim.ts";

const MOCK_APP = {
  application_id: "app_claimed",
  name: "My Claimed App",
  instances: [
    { instance_id: "ins_dev", environment_type: "development", publishable_key: "pk_test_abc" },
    { instance_id: "ins_prod", environment_type: "production", publishable_key: "pk_live_abc" },
  ],
};

describe("attemptAutoclaim", () => {
  const originalFetch = globalThis.fetch;
  let tempDir: string;
  useCaptureLog();
  let linkAppSpy: ReturnType<typeof spyOn>;
  let readBreadcrumbSpy: ReturnType<typeof spyOn>;
  let clearBreadcrumbSpy: ReturnType<typeof spyOn>;
  let pullSpy: ReturnType<typeof spyOn>;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "clerk-autoclaim-test-"));
    process.env.CLERK_PLATFORM_API_KEY = "ak_test_key";
    process.env.CLERK_PLATFORM_API_URL = "https://test-api.clerk.com";
    linkAppSpy = spyOn(autolinkMod, "linkApp").mockResolvedValue({
      path: tempDir,
      profile: {} as Profile,
    });
    clearBreadcrumbSpy = spyOn(keylessMod, "clearKeylessBreadcrumb").mockResolvedValue(undefined);
    readBreadcrumbSpy = spyOn(keylessMod, "readKeylessBreadcrumb").mockResolvedValue(undefined);
    pullSpy = spyOn(pullMod, "pull").mockResolvedValue(undefined);
  });

  afterEach(async () => {
    delete process.env.CLERK_PLATFORM_API_KEY;
    delete process.env.CLERK_PLATFORM_API_URL;
    globalThis.fetch = originalFetch;
    linkAppSpy.mockRestore();
    readBreadcrumbSpy.mockRestore();
    clearBreadcrumbSpy.mockRestore();
    pullSpy.mockRestore();
    await rm(tempDir, { recursive: true, force: true });
  });

  function withBreadcrumb(token = "valid_token") {
    readBreadcrumbSpy.mockResolvedValue({ claimToken: token, createdAt: new Date().toISOString() });
  }

  function run() {
    return attemptAutoclaim(tempDir);
  }

  test("returns not_keyless when no breadcrumb exists", async () => {
    const result = await run();
    expect(result.status).toBe("not_keyless");
    expect(linkAppSpy).not.toHaveBeenCalled();
  });

  test("claims, calls linkApp, and pulls env on success", async () => {
    withBreadcrumb();
    stubFetch(async () => new Response(JSON.stringify(MOCK_APP), { status: 200 }));

    const result = await run();

    expect(result.status).toBe("claimed");
    if (result.status === "claimed") {
      expect(result.app.application_id).toBe("app_claimed");
      expect(result.envPulled).toBe(true);
    }
    expect(linkAppSpy).toHaveBeenCalledWith(MOCK_APP, tempDir);
    expect(pullSpy).toHaveBeenCalledWith({});
  });

  test("returns envPulled false when pull fails", async () => {
    withBreadcrumb();
    stubFetch(async () => new Response(JSON.stringify(MOCK_APP), { status: 200 }));
    pullSpy.mockRejectedValue(new Error("no profile linked"));

    const result = await run();

    expect(result.status).toBe("claimed");
    if (result.status === "claimed") {
      expect(result.envPulled).toBe(false);
    }
    expect(linkAppSpy).toHaveBeenCalled();
  });

  test("clears breadcrumb after successful claim", async () => {
    withBreadcrumb();
    stubFetch(async () => new Response(JSON.stringify(MOCK_APP), { status: 200 }));

    await run();

    expect(clearBreadcrumbSpy).toHaveBeenCalledWith(tempDir);
  });

  test("returns not_found and clears breadcrumb on 404", async () => {
    withBreadcrumb("expired_token");
    stubFetch(async () => new Response("Not Found", { status: 404 }));

    const result = await run();

    expect(result.status).toBe("not_found");
    expect(clearBreadcrumbSpy).toHaveBeenCalled();
  });

  test("returns no_organization and clears breadcrumb on 403", async () => {
    withBreadcrumb("forbidden_token");
    stubFetch(async () => new Response("Forbidden", { status: 403 }));

    const result = await run();

    expect(result.status).toBe("no_organization");
    expect(clearBreadcrumbSpy).toHaveBeenCalled();
  });

  test("returns failed (preserves breadcrumb) on 400 — could be recoverable (e.g. 401 re-login)", async () => {
    withBreadcrumb("bad_token");
    stubFetch(async () => new Response("Bad Request", { status: 400 }));

    const result = await run();

    expect(result.status).toBe("failed");
    expect(clearBreadcrumbSpy).not.toHaveBeenCalled();
  });

  test("returns failed (preserves breadcrumb) on 429 rate limit", async () => {
    withBreadcrumb("rate_limited_token");
    stubFetch(async () => new Response("Too Many Requests", { status: 429 }));

    const result = await run();

    expect(result.status).toBe("failed");
    expect(clearBreadcrumbSpy).not.toHaveBeenCalled();
  });

  test("returns failed on server error without clearing breadcrumb", async () => {
    withBreadcrumb("server_error_token");
    stubFetch(async () => new Response("Internal Server Error", { status: 500 }));

    const result = await run();

    expect(result.status).toBe("failed");
    if (result.status === "failed") {
      expect(result.error).toBeInstanceOf(Error);
    }
    expect(clearBreadcrumbSpy).not.toHaveBeenCalled();
  });

  test("does not call linkApp on failure", async () => {
    withBreadcrumb();
    stubFetch(async () => new Response("Server Error", { status: 500 }));

    await run();

    expect(linkAppSpy).not.toHaveBeenCalled();
  });

  test("sends claim token and app name in request body", async () => {
    withBreadcrumb("my_claim_token");
    let capturedBody: string | undefined;
    stubFetch(async (_input, init) => {
      capturedBody = init?.body as string;
      return new Response(JSON.stringify(MOCK_APP), { status: 200 });
    });

    await run();

    const parsed = JSON.parse(capturedBody!);
    expect(parsed.token).toBe("my_claim_token");
    // no package.json in tempDir, so basename is used; assert exact value
    expect(parsed.name).toBe(basename(tempDir));
  });
});
