import { test, expect, describe, beforeEach, afterEach, spyOn } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join, basename } from "node:path";
import { tmpdir } from "node:os";
import { stubFetch, useCaptureLog } from "../test/lib/stubs.ts";
import { useCleanClerkKeyEnv, useSyntheticShellClerkKeys } from "../test/lib/clerk-key-env.ts";

import * as autolinkMod from "./autolink.ts";
import * as configMod from "./config.ts";
import * as keylessMod from "./keyless.ts";
import { setLogLevel } from "./log.ts";
import * as pullMod from "../commands/env/pull.ts";
import type { Profile } from "./config.ts";
import { attemptAutoclaim, readInitClaim } from "./autoclaim.ts";

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

// A synthetic key under every Clerk name for the whole file, cleared before
// each test: a test that read the shell would fail on a synthetic value.
useSyntheticShellClerkKeys();

describe("attemptAutoclaim", () => {
  useCleanClerkKeyEnv();
  const originalFetch = globalThis.fetch;
  let tempDir: string;
  useCaptureLog();
  let linkAppSpy: ReturnType<typeof spyOn>;
  let readBreadcrumbSpy: ReturnType<typeof spyOn>;
  let clearBreadcrumbSpy: ReturnType<typeof spyOn>;
  let pullSpy: ReturnType<typeof spyOn>;
  let resolveProfileSpy: ReturnType<typeof spyOn>;

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
    resolveProfileSpy = spyOn(configMod, "resolveProfile").mockResolvedValue(undefined);
  });

  afterEach(async () => {
    delete process.env.CLERK_PLATFORM_API_KEY;
    delete process.env.CLERK_PLATFORM_API_URL;
    globalThis.fetch = originalFetch;
    linkAppSpy.mockRestore();
    readBreadcrumbSpy.mockRestore();
    clearBreadcrumbSpy.mockRestore();
    pullSpy.mockRestore();
    resolveProfileSpy.mockRestore();
    setLogLevel("info");
    await rm(tempDir, { recursive: true, force: true });
  });

  function withBreadcrumb(token = "valid_token") {
    readBreadcrumbSpy.mockResolvedValue({ claimToken: token, createdAt: new Date().toISOString() });
  }

  /** Reads the token the way login does, once, then claims exactly that token. */
  async function run() {
    const init = await readInitClaim(tempDir);
    if (!init) throw new Error("no init token: call withBreadcrumb() first");
    return attemptAutoclaim(tempDir, init);
  }

  test("finds nothing to claim when no breadcrumb exists", async () => {
    expect(await readInitClaim(tempDir)).toBeUndefined();
  });

  test("reads the token and the name the claim will give the app", async () => {
    withBreadcrumb("my_claim_token");

    expect(await readInitClaim(tempDir)).toEqual({
      appName: basename(tempDir),
      claimToken: "my_claim_token",
    });
  });

  test("claims, calls linkApp, and pulls env on success", async () => {
    withBreadcrumb();
    stubFetch(async () => new Response(JSON.stringify(MOCK_APP), { status: 200 }));

    const result = await run();

    expect(result.status).toBe("claimed");
    if (result.status === "claimed") {
      expect(result.app.application_id).toBe("app_claimed");
      expect(result.local).toEqual({ kind: "linked", envPulled: true });
    }
    expect(linkAppSpy).toHaveBeenCalledWith(MOCK_APP, tempDir);
    // The folder the check read, not the process's working directory.
    expect(pullSpy).toHaveBeenCalledWith({ cwd: tempDir });
  });

  test("reports the folder linked but its keys not pulled when pull fails", async () => {
    withBreadcrumb();
    stubFetch(async () => new Response(JSON.stringify(MOCK_APP), { status: 200 }));
    pullSpy.mockRejectedValue(new Error("no profile linked"));

    const result = await run();

    expect(result.status).toBe("claimed");
    if (result.status === "claimed") {
      expect(result.local).toEqual({ kind: "linked", envPulled: false });
    }
    expect(linkAppSpy).toHaveBeenCalled();
  });

  test("clears breadcrumb after successful claim", async () => {
    withBreadcrumb();
    stubFetch(async () => new Response(JSON.stringify(MOCK_APP), { status: 200 }));

    await run();

    // Only while the file still holds the claimed token.
    expect(clearBreadcrumbSpy).toHaveBeenCalledWith(tempDir, "valid_token");
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
  describe("after a successful claim, the folder", () => {
    const CLAIMED_HOST = "claimed-app.clerk.accounts.dev";
    const CLAIMED_PK = publishableKeyFor(CLAIMED_HOST);
    const CLAIMED_SK = "sk_test_claimed_app_secret";
    const OTHER_PK = publishableKeyFor("other-app.clerk.accounts.dev");
    const OTHER_SK = "sk_test_other_app_secret";

    const CLAIMED_APP = {
      application_id: "app_claimed",
      name: "My Claimed App",
      instances: [
        {
          instance_id: "ins_dev",
          environment_type: "development",
          publishable_key: CLAIMED_PK,
          secret_key: CLAIMED_SK,
        },
      ],
    };

    function publishableKeyFor(host: string): string {
      return `pk_test_${btoa(`${host}$`)}`;
    }

    /** The claim answers with `claimResponse`; a fetch of the app answers with `fetched`. */
    function stubPlatform(claimResponse: unknown, fetched: Response | unknown = CLAIMED_APP) {
      const appFetches: string[] = [];
      stubFetch(async (input) => {
        const url = input instanceof Request ? input.url : String(input);
        if (url.endsWith("/v1/platform/accountless_applications/claim")) {
          return Response.json(claimResponse);
        }
        if (url.includes("/v1/platform/applications/app_claimed")) {
          appFetches.push(url);
          return fetched instanceof Response ? fetched : Response.json(fetched);
        }
        throw new Error(`unexpected fetch: ${url}`);
      });
      return appFetches;
    }

    async function writeEnv(lines: string[]): Promise<string> {
      const content = `${lines.join("\n")}\n`;
      await Bun.write(join(tempDir, ".env"), content);
      return content;
    }

    async function runClaim() {
      withBreadcrumb();
      const result = await run();
      if (result.status !== "claimed") throw new Error(`expected a claim, got ${result.status}`);
      return result;
    }

    function expectLeftAlone() {
      expect(linkAppSpy).not.toHaveBeenCalled();
      expect(pullSpy).not.toHaveBeenCalled();
      // The token is spent whether or not the folder was set up.
      expect(clearBreadcrumbSpy).toHaveBeenCalledWith(tempDir, "valid_token");
    }

    test("is linked and its keys pulled when both its keys are the claimed app's", async () => {
      stubPlatform(CLAIMED_APP);
      await writeEnv([`CLERK_PUBLISHABLE_KEY=${CLAIMED_PK}`, `CLERK_SECRET_KEY=${CLAIMED_SK}`]);

      const result = await runClaim();

      expect(result.local).toEqual({ kind: "linked", envPulled: true });
      expect(linkAppSpy).toHaveBeenCalledWith(CLAIMED_APP, tempDir);
      expect(pullSpy).toHaveBeenCalled();
    });

    test("is linked when it has no Clerk keys at all, without fetching the app", async () => {
      const appFetches = stubPlatform(CLAIMED_APP);

      const result = await runClaim();

      expect(result.local).toEqual({ kind: "linked", envPulled: true });
      expect(appFetches).toHaveLength(0);
    });

    test("is linked when its publishable key differs in text but names the same Frontend API host", async () => {
      stubPlatform(CLAIMED_APP);
      // Same host, base64 padding dropped: a different string for the same app.
      const unpadded = CLAIMED_PK.replace(/=+$/, "");
      expect(unpadded).not.toBe(CLAIMED_PK);
      await writeEnv([`CLERK_PUBLISHABLE_KEY=${unpadded}`]);

      const result = await runClaim();

      expect(result.local).toEqual({ kind: "linked", envPulled: true });
    });

    test("is linked when its publishable key can't be decoded but is the claimed app's own key", async () => {
      // MOCK_APP's keys aren't in the real format; an identical key needs no decoding.
      stubPlatform(MOCK_APP);
      await writeEnv(["CLERK_PUBLISHABLE_KEY=pk_test_abc"]);

      const result = await runClaim();

      expect(result.local).toEqual({ kind: "linked", envPulled: true });
    });

    test("is linked when it is already linked to the claimed app and holds its keys", async () => {
      stubPlatform(CLAIMED_APP);
      resolveProfileSpy.mockResolvedValue({
        path: "github.com/test/project",
        profile: { workspaceId: "", appId: "app_claimed", instances: { development: "ins_dev" } },
        resolvedVia: "remote",
      });
      await writeEnv([`CLERK_PUBLISHABLE_KEY=${CLAIMED_PK}`]);

      const result = await runClaim();

      expect(result.local).toEqual({ kind: "linked", envPulled: true });
    });

    test.each([
      {
        name: "a different publishable key next to the claimed app's secret key",
        env: [`CLERK_PUBLISHABLE_KEY=${OTHER_PK}`, `CLERK_SECRET_KEY=${CLAIMED_SK}`],
        key: "publishable",
        variable: "CLERK_PUBLISHABLE_KEY",
        mixed: true,
        linkCanTryKey: false,
      },
      {
        name: "a different secret key next to the claimed app's publishable key",
        env: [`CLERK_PUBLISHABLE_KEY=${CLAIMED_PK}`, `CLERK_SECRET_KEY=${OTHER_SK}`],
        key: "secret",
        variable: "CLERK_SECRET_KEY",
        mixed: true,
        linkCanTryKey: false,
      },
      {
        // Both differ; the publishable key the app loads is reported, and plain
        // `clerk link` can try to match it.
        name: "two keys, neither the claimed app's",
        env: [`CLERK_SECRET_KEY=${OTHER_SK}`, `CLERK_PUBLISHABLE_KEY=${OTHER_PK}`],
        key: "publishable",
        variable: "CLERK_PUBLISHABLE_KEY",
        mixed: false,
        linkCanTryKey: true,
      },
      {
        name: "only a secret key, which isn't the claimed app's",
        env: [`CLERK_SECRET_KEY=${OTHER_SK}`],
        key: "secret",
        variable: "CLERK_SECRET_KEY",
        mixed: false,
        linkCanTryKey: false,
      },
    ] as const)(
      "is left alone when it holds $name",
      async ({ env, key, variable, mixed, linkCanTryKey }) => {
        stubPlatform(CLAIMED_APP);
        const before = await writeEnv([...env]);

        const result = await runClaim();

        expect(result.local).toEqual({
          kind: "unchanged",
          reason: "different_keys",
          key,
          name: variable,
          source: ".env",
          mixed,
          linkCanTryKey,
        });
        expectLeftAlone();
        expect(await Bun.file(join(tempDir, ".env")).text()).toBe(before);
      },
    );

    test("is linked when it holds only a secret key, which is the claimed app's", async () => {
      stubPlatform(CLAIMED_APP);
      await writeEnv([`CLERK_SECRET_KEY=${CLAIMED_SK}`]);

      const result = await runClaim();

      expect(result.local).toEqual({ kind: "linked", envPulled: true });
    });

    test("is left alone when another app's plain secret key sits next to a stale SDK keyless file for the claimed app", async () => {
      stubPlatform(CLAIMED_APP);
      const before = await writeEnv([`CLERK_SECRET_KEY=${OTHER_SK}`]);
      await Bun.write(
        join(tempDir, ".clerk", ".tmp", "keyless.json"),
        JSON.stringify({ publishableKey: CLAIMED_PK, secretKey: CLAIMED_SK }),
      );

      const result = await runClaim();

      // The app loads the plain key, so the SDK file's matching keys don't count.
      expect(result.local).toEqual({
        kind: "unchanged",
        reason: "different_keys",
        key: "secret",
        name: "CLERK_SECRET_KEY",
        source: ".env",
        mixed: false,
        linkCanTryKey: false,
      });
      expectLeftAlone();
      expect(await Bun.file(join(tempDir, ".env")).text()).toBe(before);
    });

    test("is left alone when its publishable key can't be decoded", async () => {
      stubPlatform(CLAIMED_APP);
      await writeEnv(["CLERK_PUBLISHABLE_KEY=pk_test_not-base64!"]);

      const result = await runClaim();

      expect(result.local).toEqual({ kind: "unchanged", reason: "unverified" });
      expectLeftAlone();
    });

    test("is left alone, as different keys, when one key differs and the other can't be compared", async () => {
      stubPlatform(CLAIMED_APP);
      await writeEnv(["CLERK_PUBLISHABLE_KEY=pk_test_not-base64!", `CLERK_SECRET_KEY=${OTHER_SK}`]);

      const result = await runClaim();

      expect(result.local).toEqual({
        kind: "unchanged",
        reason: "different_keys",
        key: "secret",
        name: "CLERK_SECRET_KEY",
        source: ".env",
        mixed: false,
        linkCanTryKey: false,
      });
      expectLeftAlone();
    });

    test("is left alone when it is linked to another app, even with the claimed app's keys", async () => {
      const appFetches = stubPlatform(CLAIMED_APP);
      resolveProfileSpy.mockResolvedValue({
        path: "github.com/test/project",
        profile: {
          workspaceId: "",
          appId: "app_other",
          appName: "Other App",
          instances: { development: "ins_other" },
        },
        resolvedVia: "remote",
      });
      await writeEnv([`CLERK_PUBLISHABLE_KEY=${CLAIMED_PK}`, `CLERK_SECRET_KEY=${CLAIMED_SK}`]);

      const result = await runClaim();

      expect(result.local).toEqual({
        kind: "unchanged",
        reason: "linked_elsewhere",
        linkedTo: { appId: "app_other", appName: "Other App" },
      });
      expectLeftAlone();
      expect(appFetches).toHaveLength(0);
    });

    // An exception during the lookup, such as a permission error. A corrupt
    // config doesn't land here: the config reader turns it into an empty one,
    // and `clerk link`'s own already-linked check reads that same empty config
    // before any claim runs, so no claim check could see such a link.
    test("is left alone when looking up its link throws", async () => {
      stubPlatform(CLAIMED_APP);
      resolveProfileSpy.mockRejectedValue(new Error("EACCES: permission denied"));

      const result = await runClaim();

      expect(result.local).toEqual({ kind: "unchanged", reason: "unverified" });
      expectLeftAlone();
    });

    test("is linked after one fetch when the claim response has no instances", async () => {
      const appFetches = stubPlatform({ application_id: "app_claimed", name: "My Claimed App" });
      await writeEnv([`CLERK_PUBLISHABLE_KEY=${CLAIMED_PK}`, `CLERK_SECRET_KEY=${CLAIMED_SK}`]);

      const result = await runClaim();

      expect(appFetches).toHaveLength(1);
      expect(appFetches[0]).toContain("include_secret_keys=true");
      expect(result.local).toEqual({ kind: "linked", envPulled: true });
      // The link and the reported app use the fetched copy, which lists the instances.
      expect(linkAppSpy).toHaveBeenCalledWith(CLAIMED_APP, tempDir);
      expect(result.app).toEqual(CLAIMED_APP);
    });

    test("is linked after one fetch when the claim response has no instances and the folder has no keys", async () => {
      const appFetches = stubPlatform({ application_id: "app_claimed", name: "My Claimed App" });

      const result = await runClaim();

      expect(appFetches).toHaveLength(1);
      expect(result.local).toEqual({ kind: "linked", envPulled: true });
      expect(linkAppSpy).toHaveBeenCalledWith(CLAIMED_APP, tempDir);
    });

    test("reports a failed link when the claim response has no instances, the folder has no keys, and the fetch fails", async () => {
      stubPlatform(
        { application_id: "app_claimed", name: "My Claimed App" },
        new Response(JSON.stringify({ errors: [{ message: "boom" }] }), { status: 500 }),
      );

      const result = await runClaim();

      expect(result.local).toEqual({
        kind: "link_failed",
        reason: "the claim response listed no environments and fetching the application failed",
      });
      expect(linkAppSpy).not.toHaveBeenCalled();
      expect(pullSpy).not.toHaveBeenCalled();
    });

    test("is left alone when the claim response has no instances, the folder holds keys, and the fetch fails", async () => {
      const appFetches = stubPlatform(
        { application_id: "app_claimed", name: "My Claimed App" },
        new Response(JSON.stringify({ errors: [{ message: "boom" }] }), { status: 500 }),
      );
      await writeEnv([`CLERK_PUBLISHABLE_KEY=${CLAIMED_PK}`]);

      const result = await runClaim();

      expect(appFetches).toHaveLength(1);
      expect(result.local).toEqual({ kind: "unchanged", reason: "unverified" });
      expectLeftAlone();
    });

    test.each([
      {
        name: "the fetch fails",
        fetched: new Response(JSON.stringify({ errors: [{ message: "boom" }] }), { status: 500 }),
      },
      {
        name: "the fetched app still has no secret key",
        fetched: {
          ...CLAIMED_APP,
          instances: [{ ...CLAIMED_APP.instances[0]!, secret_key: undefined }],
        },
      },
    ])(
      "is left alone when the claim response lacks the secret key and $name",
      async ({ fetched }) => {
        const withoutSecret = {
          ...CLAIMED_APP,
          instances: [{ ...CLAIMED_APP.instances[0]!, secret_key: undefined }],
        };
        const appFetches = stubPlatform(withoutSecret, fetched);
        await writeEnv([`CLERK_PUBLISHABLE_KEY=${CLAIMED_PK}`, `CLERK_SECRET_KEY=${CLAIMED_SK}`]);

        const result = await runClaim();

        expect(appFetches).toHaveLength(1);
        expect(result.local).toEqual({ kind: "unchanged", reason: "unverified" });
        expectLeftAlone();
      },
    );

    test("reports a failed link, not a linked folder, when the app has no development instance", async () => {
      stubPlatform(CLAIMED_APP);
      linkAppSpy.mockResolvedValue(undefined);

      const result = await runClaim();

      expect(result.local).toEqual({
        kind: "link_failed",
        reason: "the application has no development instance",
      });
      expect(pullSpy).not.toHaveBeenCalled();
    });

    test("reports a failed link when writing the link throws", async () => {
      stubPlatform(CLAIMED_APP);
      linkAppSpy.mockRejectedValue(new Error("config directory is read-only"));

      const result = await runClaim();

      expect(result.local).toEqual({
        kind: "link_failed",
        reason: "config directory is read-only",
      });
      expect(pullSpy).not.toHaveBeenCalled();
    });

    test.each([
      { file: ".env.development.local", note: "the file `clerk env pull` writes first" },
      { file: ".env.development", note: "a file Next.js and Vite load in development" },
      { file: ".env.local", note: "the generic local file" },
    ])("is left alone when another app's key sits in $file, $note", async ({ file }) => {
      stubPlatform(CLAIMED_APP);
      await writeEnv([`CLERK_PUBLISHABLE_KEY=${CLAIMED_PK}`, `CLERK_SECRET_KEY=${CLAIMED_SK}`]);
      const before = `CLERK_SECRET_KEY=${OTHER_SK}\n`;
      await Bun.write(join(tempDir, file), before);

      const result = await runClaim();

      expect(result.local).toEqual({
        kind: "unchanged",
        reason: "different_keys",
        key: "secret",
        name: "CLERK_SECRET_KEY",
        source: file,
        mixed: true,
        linkCanTryKey: false,
      });
      expectLeftAlone();
      expect(await Bun.file(join(tempDir, file)).text()).toBe(before);
    });

    test("is left alone when the shell exports the claimed app's key but .env holds another app's", async () => {
      stubPlatform(CLAIMED_APP);
      process.env.CLERK_PUBLISHABLE_KEY = CLAIMED_PK;
      await writeEnv([`CLERK_PUBLISHABLE_KEY=${OTHER_PK}`]);

      const result = await runClaim();

      expect(result.local).toEqual({
        kind: "unchanged",
        reason: "different_keys",
        key: "publishable",
        name: "CLERK_PUBLISHABLE_KEY",
        source: ".env",
        mixed: true,
        linkCanTryKey: false,
      });
      expectLeftAlone();
    });

    test("is linked when every file holds the claimed app's keys", async () => {
      stubPlatform(CLAIMED_APP);
      await writeEnv([`CLERK_PUBLISHABLE_KEY=${CLAIMED_PK}`]);
      await Bun.write(join(tempDir, ".env.development.local"), `CLERK_SECRET_KEY=${CLAIMED_SK}\n`);

      const result = await runClaim();

      expect(result.local).toEqual({ kind: "linked", envPulled: true });
    });

    describe("with only an SDK keyless file", () => {
      async function writeSdkKeylessFile(content: string) {
        await Bun.write(join(tempDir, ".clerk", ".tmp", "keyless.json"), content);
      }

      test("is linked when the file holds the claimed app's keys", async () => {
        stubPlatform(CLAIMED_APP);
        await writeSdkKeylessFile(
          JSON.stringify({ publishableKey: CLAIMED_PK, secretKey: CLAIMED_SK }),
        );

        const result = await runClaim();

        expect(result.local).toEqual({ kind: "linked", envPulled: true });
      });

      test("is left alone when the file holds another app's keys", async () => {
        stubPlatform(CLAIMED_APP);
        await writeSdkKeylessFile(
          JSON.stringify({ publishableKey: OTHER_PK, secretKey: OTHER_SK }),
        );

        const result = await runClaim();

        expect(result.local).toEqual({
          kind: "unchanged",
          reason: "different_keys",
          key: "publishable",
          name: "publishableKey",
          source: ".clerk/.tmp/keyless.json",
          mixed: false,
          // An SDK-only folder: `clerk link` matches the SDK file's key.
          linkCanTryKey: true,
        });
        expectLeftAlone();
      });

      test.each([
        { name: "can't be parsed", content: "{ half-written" },
        { name: "isn't a JSON object", content: "null" },
        {
          name: "holds no key",
          content: JSON.stringify({ claimUrl: "https://example.com/claim" }),
        },
      ])("is left alone, as couldn't tell, when the file $name", async ({ content }) => {
        stubPlatform(CLAIMED_APP);
        await writeSdkKeylessFile(content);

        const result = await runClaim();

        expect(result.local).toEqual({ kind: "unchanged", reason: "unverified" });
        expectLeftAlone();
      });
    });

    describe("with keys the CLI can't read or that sit under other names", () => {
      test.each([
        { name: "spaces around =", line: `CLERK_SECRET_KEY = ${OTHER_SK}` },
        { name: "an indented line", line: `  CLERK_SECRET_KEY=${OTHER_SK}` },
      ])("is left alone, as couldn't tell, when a key line has $name", async ({ line }) => {
        const appFetches = stubPlatform(CLAIMED_APP);
        await writeEnv([line]);

        const result = await runClaim();

        expect(result.local).toEqual({ kind: "unchanged", reason: "unverified" });
        expectLeftAlone();
        // The claim response was complete; a fetch can't read the folder's line.
        expect(appFetches).toHaveLength(0);
      });

      test.each([
        { name: "a trailing comment", value: `${CLAIMED_SK} # from clerk init` },
        { name: "a variable reference", value: "${SHARED_CLERK_SECRET}" },
        { name: "a placeholder", value: "your-secret-key-here" },
      ])("is left alone, as couldn't tell, when a key's value holds $name", async ({ value }) => {
        const appFetches = stubPlatform(CLAIMED_APP);
        await writeEnv([`CLERK_PUBLISHABLE_KEY=${CLAIMED_PK}`, `CLERK_SECRET_KEY=${value}`]);

        const result = await runClaim();

        expect(result.local).toEqual({ kind: "unchanged", reason: "unverified" });
        expectLeftAlone();
        expect(appFetches).toHaveLength(0);
      });

      test("reports another app's readable key even when another line can't be read", async () => {
        stubPlatform(CLAIMED_APP);
        await writeEnv([`  CLERK_SECRET_KEY=${CLAIMED_SK}`, `CLERK_PUBLISHABLE_KEY=${OTHER_PK}`]);

        const result = await runClaim();

        expect(result.local).toMatchObject({
          kind: "unchanged",
          reason: "different_keys",
          name: "CLERK_PUBLISHABLE_KEY",
          // The unreadable line leaves `clerk link` unsure which key the app loads.
          linkCanTryKey: false,
        });
        expectLeftAlone();
      });

      test("is left alone when another app's keys sit under a framework's names the CLI didn't detect", async () => {
        stubPlatform(CLAIMED_APP);
        await writeEnv([
          `NUXT_CLERK_SECRET_KEY=${OTHER_SK}`,
          `CLERK_PUBLISHABLE_KEY=${CLAIMED_PK}`,
          `CLERK_SECRET_KEY=${CLAIMED_SK}`,
        ]);

        const result = await runClaim();

        expect(result.local).toEqual({
          kind: "unchanged",
          reason: "different_keys",
          key: "secret",
          name: "NUXT_CLERK_SECRET_KEY",
          source: ".env",
          mixed: true,
          linkCanTryKey: false,
        });
        expectLeftAlone();
      });
    });

    // The key-shape filter covers modern `pk_`/`sk_` keys; an identical key of
    // any format is still the claimed app's.
    test("is linked when it holds a legacy-format secret key identical to the claimed app's", async () => {
      const legacy = {
        ...CLAIMED_APP,
        instances: [{ ...CLAIMED_APP.instances[0]!, secret_key: "test_legacysecret0123" }],
      };
      stubPlatform(legacy);
      await writeEnv([
        `CLERK_PUBLISHABLE_KEY=${CLAIMED_PK}`,
        "CLERK_SECRET_KEY=test_legacysecret0123",
      ]);

      const result = await runClaim();

      expect(result.local).toEqual({ kind: "linked", envPulled: true });
    });

    test("is left alone, as couldn't tell, when it holds a different legacy-format key", async () => {
      stubPlatform(CLAIMED_APP);
      await writeEnv([
        `CLERK_PUBLISHABLE_KEY=${CLAIMED_PK}`,
        "CLERK_SECRET_KEY=test_someotherlegacykey",
      ]);

      const result = await runClaim();

      expect(result.local).toEqual({ kind: "unchanged", reason: "unverified" });
      expectLeftAlone();
    });

    describe("which mismatched key the warning names", () => {
      test("names the publishable key the app loads, not the first one found", async () => {
        stubPlatform(CLAIMED_APP);
        const SECOND_OTHER_PK = publishableKeyFor("third-app.clerk.accounts.dev");
        await writeEnv([`CLERK_PUBLISHABLE_KEY=${OTHER_PK}`]);
        await Bun.write(join(tempDir, ".env.local"), `CLERK_PUBLISHABLE_KEY=${SECOND_OTHER_PK}\n`);

        const result = await runClaim();

        // `.env.local` overrides `.env`, so that's the key `clerk link` will try.
        expect(result.local).toMatchObject({
          reason: "different_keys",
          source: ".env.local",
          linkCanTryKey: true,
        });
      });

      test("doesn't offer plain `clerk link` when the folder is already linked to the claimed app", async () => {
        stubPlatform(CLAIMED_APP);
        resolveProfileSpy.mockResolvedValue({
          path: "github.com/test/project",
          profile: { workspaceId: "", appId: "app_claimed", instances: { development: "ins_dev" } },
          resolvedVia: "remote",
        });
        await writeEnv([`CLERK_PUBLISHABLE_KEY=${OTHER_PK}`]);

        const result = await runClaim();

        // `clerk link` in a linked folder keeps the link instead of matching keys.
        expect(result.local).toMatchObject({ reason: "different_keys", linkCanTryKey: false });
      });
    });

    describe("with verbose logging on", () => {
      const captured = useCaptureLog();

      test.each([
        {
          name: "a secret key that differs, found after a fetch",
          claim: {
            ...CLAIMED_APP,
            instances: [{ ...CLAIMED_APP.instances[0]!, secret_key: undefined }],
          },
          env: [`CLERK_PUBLISHABLE_KEY=${CLAIMED_PK}`, `CLERK_SECRET_KEY=${OTHER_SK}`],
        },
        {
          name: "a publishable key that can't be decoded",
          claim: CLAIMED_APP,
          env: ["CLERK_PUBLISHABLE_KEY=pk_test_not-base64!", `CLERK_SECRET_KEY=${CLAIMED_SK}`],
        },
        {
          name: "matching keys",
          claim: CLAIMED_APP,
          env: [`CLERK_PUBLISHABLE_KEY=${CLAIMED_PK}`, `CLERK_SECRET_KEY=${CLAIMED_SK}`],
        },
      ])("never logs a key's value: $name", async ({ claim, env }) => {
        setLogLevel("debug");
        stubPlatform(claim);
        await writeEnv([...env]);

        await runClaim();

        expect(captured.err).toContain("autoclaim:");
        const leaked = [CLAIMED_PK, CLAIMED_SK, OTHER_PK, OTHER_SK, "pk_test_not-base64!"].filter(
          (value) => captured.err.includes(value),
        );
        expect(leaked).toEqual([]);
      });
    });
  });
});
