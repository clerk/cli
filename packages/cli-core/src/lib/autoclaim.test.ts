import { test, expect, describe, beforeEach, afterEach, spyOn } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join, basename } from "node:path";
import { tmpdir } from "node:os";
import { stubFetch, useCaptureLog } from "../test/lib/stubs.ts";

import * as autolinkMod from "./autolink.ts";
import * as keylessMod from "./keyless.ts";
import * as pullMod from "../commands/env/pull.ts";
import type { Profile } from "./config.ts";
import { attemptAutoclaim, claimWarning, keysMismatchMessage } from "./autoclaim.ts";

const MOCK_APP = {
  application_id: "app_claimed",
  name: "My Claimed App",
  instances: [
    { instance_id: "ins_dev", environment_type: "development", publishable_key: "pk_test_abc" },
    { instance_id: "ins_prod", environment_type: "production", publishable_key: "pk_live_abc" },
  ],
};

const MANAGED_WORKSPACE_LONG_MESSAGE =
  "This workspace is managed by Vercel. Switch to a workspace you own and claim the application there.";

const MANAGED_WORKSPACE_BODY = JSON.stringify({
  errors: [
    {
      code: "accountless_application_managed_workspace",
      message: "Cannot claim into a managed workspace",
      long_message: MANAGED_WORKSPACE_LONG_MESSAGE,
    },
  ],
});

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

  test("returns no_organization and clears breadcrumb on 403 with an unrelated error code", async () => {
    withBreadcrumb("forbidden_token");
    const body = JSON.stringify({
      errors: [{ code: "authorization_invalid", message: "Request not allowed" }],
    });
    stubFetch(async () => new Response(body, { status: 403 }));

    const result = await run();

    expect(result.status).toBe("no_organization");
    expect(clearBreadcrumbSpy).toHaveBeenCalled();
  });

  test("returns managed_workspace with the API long_message and preserves breadcrumb on 403 accountless_application_managed_workspace", async () => {
    withBreadcrumb("managed_token");
    stubFetch(async () => new Response(MANAGED_WORKSPACE_BODY, { status: 403 }));

    const result = await run();

    expect(result.status).toBe("managed_workspace");
    if (result.status === "managed_workspace") {
      expect(result.longMessage).toBe(MANAGED_WORKSPACE_LONG_MESSAGE);
    }
    // The claim token must survive: the user switches workspace, then runs
    // `clerk auth login` again to claim the same application.
    expect(clearBreadcrumbSpy).not.toHaveBeenCalled();
    expect(linkAppSpy).not.toHaveBeenCalled();
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
  describe("publishable keys already in the folder", () => {
    const originalKey = process.env.CLERK_PUBLISHABLE_KEY;

    beforeEach(() => {
      delete process.env.CLERK_PUBLISHABLE_KEY;
    });

    afterEach(() => {
      if (originalKey === undefined) delete process.env.CLERK_PUBLISHABLE_KEY;
      else process.env.CLERK_PUBLISHABLE_KEY = originalKey;
    });

    test("a key for another app stops before linking or pulling, and the env file is unchanged", async () => {
      withBreadcrumb();
      stubFetch(async () => new Response(JSON.stringify(MOCK_APP), { status: 200 }));
      const envPath = join(tempDir, ".env");
      const before =
        "# keep me\nCLERK_PUBLISHABLE_KEY=pk_test_other\nCLERK_SECRET_KEY=sk_test_other\n";
      await Bun.write(envPath, before);

      const result = await run();

      expect(result).toEqual({
        status: "keys_mismatch",
        app: MOCK_APP as never,
        sources: [".env"],
      });
      expect(linkAppSpy).not.toHaveBeenCalled();
      expect(pullSpy).not.toHaveBeenCalled();
      expect(await Bun.file(envPath).text()).toBe(before);
      // The claim happened, so the token is spent either way.
      expect(clearBreadcrumbSpy).toHaveBeenCalledWith(tempDir);
    });

    test("an exported key for another app names the env var as the source", async () => {
      withBreadcrumb();
      stubFetch(async () => new Response(JSON.stringify(MOCK_APP), { status: 200 }));
      process.env.CLERK_PUBLISHABLE_KEY = "pk_test_other";

      const result = await run();

      expect(result.status).toBe("keys_mismatch");
      if (result.status === "keys_mismatch") {
        expect(result.sources).toEqual(["CLERK_PUBLISHABLE_KEY env var"]);
      }
      expect(linkAppSpy).not.toHaveBeenCalled();
    });

    test("the claimed app's own key links and pulls as before", async () => {
      withBreadcrumb();
      stubFetch(async () => new Response(JSON.stringify(MOCK_APP), { status: 200 }));
      await Bun.write(join(tempDir, ".env"), "CLERK_PUBLISHABLE_KEY=pk_test_abc\n");

      const result = await run();

      expect(result.status).toBe("claimed");
      expect(linkAppSpy).toHaveBeenCalledWith(MOCK_APP, tempDir);
      expect(pullSpy).toHaveBeenCalledWith({});
    });
  });
});

describe("keysMismatchMessage", () => {
  const app = MOCK_APP as never;

  test("names the one source holding the other app's key", () => {
    expect(keysMismatchMessage({ status: "keys_mismatch", app, sources: [".env"] })).toBe(
      "Claimed application `My Claimed App` (app_claimed) into your account, but .env holds a publishable key for a different application, " +
        "so this folder wasn't linked and its keys weren't changed. " +
        "Run `clerk link --app <app_id>` with the application this folder should use.",
    );
  });

  test("lists several sources", () => {
    expect(
      keysMismatchMessage({ status: "keys_mismatch", app, sources: [".env", ".env.local"] }),
    ).toContain("but .env and .env.local hold publishable keys for a different application");
  });

  test("is the warning clerk auth login prints for the mismatch", () => {
    const result = { status: "keys_mismatch" as const, app, sources: [".env"] };
    expect(claimWarning(result)).toBe(keysMismatchMessage(result));
  });
});
