import { test, expect, describe, beforeEach, afterEach, spyOn } from "bun:test";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import { join, basename } from "node:path";
import { tmpdir } from "node:os";
import { stubFetch, useCaptureLog } from "../test/lib/stubs.ts";

import * as autolinkMod from "./autolink.ts";
import * as keylessMod from "./keyless.ts";
import * as pullMod from "../commands/env/pull.ts";
import * as credentialStoreMod from "./credential-store.ts";
import { _setConfigDir, type Profile } from "./config.ts";
import {
  attemptAutoclaim,
  claimWarning,
  keysMismatchMessage,
  reportClaimed,
  type AutoclaimResult,
} from "./autoclaim.ts";

/** Shell variables the claim reads; a developer's own must not decide these tests. */
const SHELL_VARS = ["CLERK_PUBLISHABLE_KEY", "CLERK_PLATFORM_API_KEY", "CLERK_PLATFORM_API_URL"];
const originalShell = Object.fromEntries(SHELL_VARS.map((name) => [name, process.env[name]]));

function restoreShellVars(): void {
  for (const name of SHELL_VARS) {
    if (originalShell[name] === undefined) delete process.env[name];
    else process.env[name] = originalShell[name];
  }
}

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
  let tokenSpy: ReturnType<typeof spyOn>;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "clerk-autoclaim-test-"));
    delete process.env.CLERK_PUBLISHABLE_KEY;
    // The API key keeps PLAPI off the OS keychain; the spy makes sure it stays off.
    tokenSpy = spyOn(credentialStoreMod, "getValidToken").mockResolvedValue(null);
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
    restoreShellVars();
    tokenSpy.mockRestore();
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

  function run({ checkKeys = true }: { checkKeys?: boolean } = {}) {
    return attemptAutoclaim(tempDir, { checkKeys });
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
      expect(result.linked).toBe(true);
      expect(result.envPulled).toBe(true);
    }
    expect(linkAppSpy).toHaveBeenCalledWith(MOCK_APP, tempDir);
    expect(pullSpy).toHaveBeenCalledWith({ cwd: tempDir });
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

  test("an app with no development instance is claimed but not linked, and nothing is pulled", async () => {
    withBreadcrumb();
    stubFetch(async () => new Response(JSON.stringify(MOCK_APP), { status: 200 }));
    linkAppSpy.mockResolvedValue(undefined);

    const result = await run();

    expect(result).toMatchObject({
      status: "claimed",
      linked: false,
      linkError: "the application has no development instance",
      envPulled: false,
    });
    expect(pullSpy).not.toHaveBeenCalled();
  });

  test("a failed link write is reported as not linked with its reason", async () => {
    withBreadcrumb();
    stubFetch(async () => new Response(JSON.stringify(MOCK_APP), { status: 200 }));
    linkAppSpy.mockRejectedValue(new Error("EACCES: permission denied, open 'config.json'"));

    const result = await run();

    expect(result).toMatchObject({
      status: "claimed",
      linked: false,
      linkError: "EACCES: permission denied, open 'config.json'",
      envPulled: false,
    });
    expect(pullSpy).not.toHaveBeenCalled();
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
    test.skipIf(process.getuid?.() === 0)(
      "a foreign key in a readable .env refuses even when .env.local can't be read",
      async () => {
        withBreadcrumb();
        stubFetch(async () => new Response(JSON.stringify(MOCK_APP), { status: 200 }));
        const envPath = join(tempDir, ".env");
        const localPath = join(tempDir, ".env.local");
        await Bun.write(envPath, "CLERK_PUBLISHABLE_KEY=pk_test_other\n");
        await Bun.write(localPath, "CLERK_PUBLISHABLE_KEY=pk_test_abc\n");
        await chmod(localPath, 0o000);

        let result: AutoclaimResult;
        try {
          result = await run();
        } finally {
          await chmod(localPath, 0o600);
        }

        expect(result).toEqual({
          status: "keys_mismatch",
          app: MOCK_APP as never,
          sources: [".env"],
        });
        expect(linkAppSpy).not.toHaveBeenCalled();
        expect(pullSpy).not.toHaveBeenCalled();
      },
    );

    describe("with the real link and env pull", () => {
      // The claim response carries secret keys, so a real pull writes both keys.
      const APP_WITH_KEYS = {
        application_id: "app_claimed",
        name: "My Claimed App",
        instances: [
          {
            instance_id: "ins_dev",
            environment_type: "development",
            publishable_key: "pk_test_abc",
            secret_key: "sk_test_abc",
          },
        ],
      };
      let configDir = "";
      let cwdSpy: ReturnType<typeof spyOn>;

      beforeEach(async () => {
        // Real `linkApp` saves a profile and real `pull` picks its target file and writes it.
        linkAppSpy.mockRestore();
        pullSpy.mockRestore();
        // Anything that still reads the process's directory lands in the temp folder, not the repo.
        cwdSpy = spyOn(process, "cwd").mockReturnValue(tempDir);
        configDir = await mkdtemp(join(tmpdir(), "clerk-autoclaim-config-"));
        _setConfigDir(configDir);
        withBreadcrumb();
        stubFetch(async () => new Response(JSON.stringify(APP_WITH_KEYS), { status: 200 }));
      });

      afterEach(async () => {
        cwdSpy.mockRestore();
        _setConfigDir(undefined);
        await rm(configDir, { recursive: true, force: true });
      });

      test("another app's keys in .env.development.local, the file env pull writes first, refuse the claim", async () => {
        const localPath = join(tempDir, ".env.local");
        const devLocalPath = join(tempDir, ".env.development.local");
        const local = "CLERK_PUBLISHABLE_KEY=pk_test_abc\nCLERK_SECRET_KEY=sk_test_abc\n";
        const devLocal = "CLERK_PUBLISHABLE_KEY=pk_test_bbb\nCLERK_SECRET_KEY=sk_test_bbb\n";
        await Bun.write(localPath, local);
        await Bun.write(devLocalPath, devLocal);

        const result = await attemptAutoclaim(tempDir, { checkKeys: true });

        expect(result).toEqual({
          status: "keys_mismatch",
          app: APP_WITH_KEYS as never,
          sources: [".env.development.local"],
        });
        expect(await Bun.file(localPath).text()).toBe(local);
        expect(await Bun.file(devLocalPath).text()).toBe(devLocal);
      });

      test("the claimed app's own key in .env.development.local links, and the pull writes that file", async () => {
        const devLocalPath = join(tempDir, ".env.development.local");
        await Bun.write(devLocalPath, "CLERK_PUBLISHABLE_KEY=pk_test_abc\n");

        const result = await attemptAutoclaim(tempDir, { checkKeys: true });

        expect(result).toMatchObject({ status: "claimed", linked: true, envPulled: true });
        expect(await Bun.file(devLocalPath).text()).toContain("CLERK_SECRET_KEY=sk_test_abc");
      });
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

    test("without the key check, a key for another app still links and pulls (clerk init, migrate, doctor)", async () => {
      withBreadcrumb();
      stubFetch(async () => new Response(JSON.stringify(MOCK_APP), { status: 200 }));
      await Bun.write(join(tempDir, ".env"), "CLERK_PUBLISHABLE_KEY=pk_test_other\n");

      const result = await run({ checkKeys: false });

      expect(result.status).toBe("claimed");
      expect(linkAppSpy).toHaveBeenCalledWith(MOCK_APP, tempDir);
      expect(pullSpy).toHaveBeenCalledWith({ cwd: tempDir });
    });

    /** Claims with `.env` made unreadable for the duration; returns the result and the file's content. */
    async function claimWithUnreadableEnv(): Promise<{ result: AutoclaimResult; before: string }> {
      withBreadcrumb();
      stubFetch(async () => new Response(JSON.stringify(MOCK_APP), { status: 200 }));
      const envPath = join(tempDir, ".env");
      const before = "CLERK_PUBLISHABLE_KEY=pk_test_mine\n";
      await Bun.write(envPath, before);
      await chmod(envPath, 0o000);
      try {
        return { result: await run(), before };
      } finally {
        await chmod(envPath, 0o600);
      }
    }

    // Root ignores file permissions, so an unreadable file can't be made there.
    test.skipIf(process.getuid?.() === 0)(
      "an unreadable .env with a foreign key exported stops with keys_mismatch and writes nothing",
      async () => {
        process.env.CLERK_PUBLISHABLE_KEY = "pk_test_other";

        const { result, before } = await claimWithUnreadableEnv();

        expect(result).toEqual({
          status: "keys_mismatch",
          app: MOCK_APP as never,
          sources: ["CLERK_PUBLISHABLE_KEY env var"],
        });
        expect(linkAppSpy).not.toHaveBeenCalled();
        expect(pullSpy).not.toHaveBeenCalled();
        expect(await Bun.file(join(tempDir, ".env")).text()).toBe(before);
      },
    );

    test.skipIf(process.getuid?.() === 0)(
      "an unreadable .env with no foreign key exported links the folder but writes no keys",
      async () => {
        const { result, before } = await claimWithUnreadableEnv();

        expect(result.status).toBe("claimed");
        if (result.status === "claimed") {
          expect(result.linked).toBe(true);
          expect(result.envPulled).toBe(false);
          expect(result.unreadableEnv?.file).toBe(".env");
          expect(result.unreadableEnv?.reason).toContain("EACCES");
        }
        expect(linkAppSpy).toHaveBeenCalledWith(MOCK_APP, tempDir);
        expect(pullSpy).not.toHaveBeenCalled();
        expect(await Bun.file(join(tempDir, ".env")).text()).toBe(before);
      },
    );

    test("the claimed app's own key links and pulls as before", async () => {
      withBreadcrumb();
      stubFetch(async () => new Response(JSON.stringify(MOCK_APP), { status: 200 }));
      await Bun.write(join(tempDir, ".env"), "CLERK_PUBLISHABLE_KEY=pk_test_abc\n");

      const result = await run();

      expect(result.status).toBe("claimed");
      expect(linkAppSpy).toHaveBeenCalledWith(MOCK_APP, tempDir);
      expect(pullSpy).toHaveBeenCalledWith({ cwd: tempDir });
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

describe("reportClaimed", () => {
  const captured = useCaptureLog();
  const app = MOCK_APP as never;

  test("a linked claim prints the claim line and where the app now lives", () => {
    reportClaimed({ status: "claimed", app, linked: true, envPulled: true });

    expect(captured.err).toContain("Claimed and linked application: `My Claimed App`");
    expect(captured.err).toMatch(
      /Your app now lives in your Clerk account:\n[^\n]*? {2}https:\/\/dashboard\.clerk\.com\/apps\/app_claimed\/instances\/ins_dev/,
    );
  });

  test("an unlinked claim says so, with the caller's hint", () => {
    reportClaimed(
      { status: "claimed", app, linked: false, linkError: "disk full", envPulled: false },
      { unlinkedHint: "Run `clerk link` to finish setup." },
    );

    expect(captured.err).toContain("Claimed application: `My Claimed App`");
    expect(captured.err).not.toContain("Claimed and linked");
    expect(captured.err).toContain(
      "This folder wasn't linked: disk full. Run `clerk link` to finish setup.",
    );
  });

  test("an unlinked claim without a hint prints no warning, for clerk link to link it", () => {
    reportClaimed({
      status: "claimed",
      app,
      linked: false,
      linkError: "disk full",
      envPulled: false,
    });

    expect(captured.err).not.toContain("wasn't linked");
  });

  test("an unreadable env file names the file and the reason, and says to pull later", () => {
    reportClaimed({
      status: "claimed",
      app,
      linked: true,
      envPulled: false,
      unreadableEnv: { file: ".env", reason: "EACCES: permission denied" },
    });

    expect(captured.err).toContain(
      "Couldn't read .env to check its publishable key (EACCES: permission denied), so this folder's keys weren't written. " +
        "Run `clerk env pull` once the file is fixed.",
    );
  });
});
