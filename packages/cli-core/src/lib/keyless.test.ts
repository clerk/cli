import { test, expect, describe, beforeEach, afterEach, spyOn } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { stubFetch, captureLog } from "../test/lib/stubs.ts";

const {
  parseClaimToken,
  writeKeylessBreadcrumb,
  readKeylessBreadcrumb,
  clearKeylessBreadcrumb,
  readSdkKeylessBreadcrumb,
  clearSdkKeylessBreadcrumb,
  readAnyKeylessBreadcrumb,
  writeKeysToEnvFile,
  createAccountlessApp,
} = await import("./keyless.ts");

describe("parseClaimToken", () => {
  test("extracts token from relative claim URL", () => {
    expect(parseClaimToken("/apps/claim?token=abc123&framework=nextjs")).toBe("abc123");
  });

  test("extracts token from full URL", () => {
    expect(parseClaimToken("https://dashboard.clerk.com/apps/claim?token=xyz789")).toBe("xyz789");
  });

  test("throws when no token param exists", () => {
    expect(() => parseClaimToken("/apps/claim?framework=nextjs")).toThrow("No token parameter");
  });

  test("throws on empty string", () => {
    expect(() => parseClaimToken("")).toThrow();
  });
});

describe("breadcrumb", () => {
  let tempDir: string;
  let debugSpy: ReturnType<typeof spyOn>;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "clerk-keyless-test-"));
    debugSpy = spyOn(console, "debug").mockImplementation(() => {});
  });

  afterEach(async () => {
    debugSpy.mockRestore();
    await rm(tempDir, { recursive: true, force: true });
  });

  test("write then read round-trips", async () => {
    await writeKeylessBreadcrumb(tempDir, "token_abc");
    const result = await readKeylessBreadcrumb(tempDir);

    expect(result).toBeDefined();
    expect(result!.claimToken).toBe("token_abc");
    expect(result!.createdAt).toBeTruthy();
  });

  test("read returns undefined when no breadcrumb exists", async () => {
    const result = await readKeylessBreadcrumb(tempDir);
    expect(result).toBeUndefined();
  });

  test("read returns undefined when breadcrumb is malformed JSON", async () => {
    await Bun.write(join(tempDir, ".clerk", "keyless.json"), "not json{{{");

    const captured = captureLog();
    const result = await captured.run(() => readKeylessBreadcrumb(tempDir));
    expect(result).toBeUndefined();
  });

  test("read returns undefined and clears file when breadcrumb has wrong shape", async () => {
    const breadcrumbFile = join(tempDir, ".clerk", "keyless.json");
    await Bun.write(breadcrumbFile, JSON.stringify({ claimToken: 12345, createdAt: "2024-01-01" }));

    const captured = captureLog();
    const result = await captured.run(() => readKeylessBreadcrumb(tempDir));
    expect(result).toBeUndefined();
    expect(await Bun.file(breadcrumbFile).exists()).toBe(false);
  });

  test("clear removes the breadcrumb file", async () => {
    await writeKeylessBreadcrumb(tempDir, "token_abc");
    await clearKeylessBreadcrumb(tempDir);

    const result = await readKeylessBreadcrumb(tempDir);
    expect(result).toBeUndefined();
  });

  test("clear does not throw when file is already gone", async () => {
    await clearKeylessBreadcrumb(tempDir);
    // Should not throw
  });

  test("writeKeylessBreadcrumb adds .clerk/ to .gitignore", async () => {
    await writeKeylessBreadcrumb(tempDir, "token_abc");
    const gitignore = await Bun.file(join(tempDir, ".gitignore")).text();
    expect(gitignore).toContain(".clerk/");
  });

  test("writeKeylessBreadcrumb does not duplicate .clerk/ entry if already present", async () => {
    await Bun.write(join(tempDir, ".gitignore"), ".clerk/\n");
    await writeKeylessBreadcrumb(tempDir, "token_abc");
    const gitignore = await Bun.file(join(tempDir, ".gitignore")).text();
    const matches = gitignore.split("\n").filter((l) => l.trim() === ".clerk/");
    expect(matches.length).toBe(1);
  });
});

describe("SDK breadcrumb", () => {
  let tempDir: string;
  let debugSpy: ReturnType<typeof spyOn>;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "clerk-sdk-keyless-test-"));
    debugSpy = spyOn(console, "debug").mockImplementation(() => {});
  });

  afterEach(async () => {
    debugSpy.mockRestore();
    await rm(tempDir, { recursive: true, force: true });
  });

  const SDK_BREADCRUMB = {
    publishableKey: "pk_test_sdk",
    secretKey: "sk_test_sdk",
    claimUrl: "https://dashboard.clerk.com/apps/claim?token=sdk_token_123",
    apiKeysUrl: "https://dashboard.clerk.com/apps/app_1/instances/ins_1/api-keys",
  };

  async function writeSdkBreadcrumb(data: object = SDK_BREADCRUMB) {
    const dir = join(tempDir, ".clerk", ".tmp");
    const { mkdir } = await import("node:fs/promises");
    await mkdir(dir, { recursive: true });
    await Bun.write(join(dir, "keyless.json"), JSON.stringify(data));
  }

  test("readSdkKeylessBreadcrumb returns data when file is valid", async () => {
    await writeSdkBreadcrumb();
    const result = await readSdkKeylessBreadcrumb(tempDir);
    expect(result).toBeDefined();
    expect(result!.publishableKey).toBe("pk_test_sdk");
    expect(result!.claimUrl).toContain("sdk_token_123");
  });

  test("readSdkKeylessBreadcrumb returns undefined when no file exists", async () => {
    const result = await readSdkKeylessBreadcrumb(tempDir);
    expect(result).toBeUndefined();
  });

  test("readSdkKeylessBreadcrumb returns undefined when file has wrong shape", async () => {
    await writeSdkBreadcrumb({ someOther: "data" });
    const captured = captureLog();
    const result = await captured.run(() => readSdkKeylessBreadcrumb(tempDir));
    expect(result).toBeUndefined();
  });

  test("clearSdkKeylessBreadcrumb removes the file", async () => {
    await writeSdkBreadcrumb();
    const captured = captureLog();
    await captured.run(() => clearSdkKeylessBreadcrumb(tempDir));
    const result = await readSdkKeylessBreadcrumb(tempDir);
    expect(result).toBeUndefined();
  });

  test("clearSdkKeylessBreadcrumb does not throw when file is missing", async () => {
    const captured = captureLog();
    await captured.run(() => clearSdkKeylessBreadcrumb(tempDir));
  });
});

describe("readAnyKeylessBreadcrumb", () => {
  let tempDir: string;
  let debugSpy: ReturnType<typeof spyOn>;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "clerk-any-keyless-test-"));
    debugSpy = spyOn(console, "debug").mockImplementation(() => {});
  });

  afterEach(async () => {
    debugSpy.mockRestore();
    await rm(tempDir, { recursive: true, force: true });
  });

  async function writeSdkBreadcrumb(token = "sdk_token") {
    const dir = join(tempDir, ".clerk", ".tmp");
    const { mkdir } = await import("node:fs/promises");
    await mkdir(dir, { recursive: true });
    await Bun.write(
      join(dir, "keyless.json"),
      JSON.stringify({
        publishableKey: "pk_test_sdk",
        secretKey: "sk_test_sdk",
        claimUrl: `https://dashboard.clerk.com/apps/claim?token=${token}`,
      }),
    );
  }

  test("returns undefined when neither breadcrumb exists", async () => {
    const captured = captureLog();
    const result = await captured.run(() => readAnyKeylessBreadcrumb(tempDir));
    expect(result).toBeUndefined();
  });

  test("returns SDK breadcrumb token when SDK file exists", async () => {
    await writeSdkBreadcrumb("my_sdk_token");
    const captured = captureLog();
    const result = await captured.run(() => readAnyKeylessBreadcrumb(tempDir));
    expect(result).toBeDefined();
    expect(result!.claimToken).toBe("my_sdk_token");
    expect(result!.source).toBe("sdk");
  });

  test("returns CLI breadcrumb token when CLI file exists", async () => {
    await writeKeylessBreadcrumb(tempDir, "my_cli_token");
    const captured = captureLog();
    const result = await captured.run(() => readAnyKeylessBreadcrumb(tempDir));
    expect(result).toBeDefined();
    expect(result!.claimToken).toBe("my_cli_token");
    expect(result!.source).toBe("cli");
  });

  test("prefers SDK breadcrumb when both exist", async () => {
    await writeSdkBreadcrumb("preferred_sdk_token");
    await writeKeylessBreadcrumb(tempDir, "ignored_cli_token");
    const captured = captureLog();
    const result = await captured.run(() => readAnyKeylessBreadcrumb(tempDir));
    expect(result!.claimToken).toBe("preferred_sdk_token");
    expect(result!.source).toBe("sdk");
  });

  test("falls back to CLI breadcrumb when SDK file has invalid claimUrl", async () => {
    const dir = join(tempDir, ".clerk", ".tmp");
    const { mkdir } = await import("node:fs/promises");
    await mkdir(dir, { recursive: true });
    await Bun.write(
      join(dir, "keyless.json"),
      JSON.stringify({
        publishableKey: "pk_test_sdk",
        secretKey: "sk_test_sdk",
        claimUrl: "/no-token-param",
      }),
    );
    await writeKeylessBreadcrumb(tempDir, "fallback_cli_token");

    const captured = captureLog();
    const result = await captured.run(() => readAnyKeylessBreadcrumb(tempDir));
    expect(result!.claimToken).toBe("fallback_cli_token");
    expect(result!.source).toBe("cli");
  });
});

describe("writeKeysToEnvFile", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "clerk-keyless-env-test-"));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  test("writes keys to .env.local", async () => {
    const captured = captureLog();
    await captured.run(() =>
      writeKeysToEnvFile(tempDir, {
        publishableKey: "pk_test_123",
        secretKey: "sk_test_456",
      }),
    );

    const content = await Bun.file(join(tempDir, ".env.local")).text();
    expect(content).toContain("CLERK_PUBLISHABLE_KEY=pk_test_123");
    expect(content).toContain("CLERK_SECRET_KEY=sk_test_456");
  });

  test("merges with existing env file content", async () => {
    await Bun.write(join(tempDir, ".env.local"), "EXISTING_VAR=hello\n");

    const captured = captureLog();
    await captured.run(() =>
      writeKeysToEnvFile(tempDir, {
        publishableKey: "pk_test_abc",
        secretKey: "sk_test_def",
      }),
    );

    const content = await Bun.file(join(tempDir, ".env.local")).text();
    expect(content).toContain("EXISTING_VAR=hello");
    expect(content).toContain("CLERK_PUBLISHABLE_KEY=pk_test_abc");
  });

  test("uses framework-specific key names and env file when package.json specifies Next.js", async () => {
    await Bun.write(
      join(tempDir, "package.json"),
      JSON.stringify({ dependencies: { next: "latest" } }),
    );

    const captured = captureLog();
    await captured.run(() =>
      writeKeysToEnvFile(tempDir, {
        publishableKey: "pk_test_next",
        secretKey: "sk_test_next",
      }),
    );

    // Next.js declares envFile: ".env.local" in FRAMEWORK_MAP
    const content = await Bun.file(join(tempDir, ".env.local")).text();
    expect(content).toContain("NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=pk_test_next");
    expect(content).toContain("CLERK_SECRET_KEY=sk_test_next");
  });
});

describe("createAccountlessApp", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test("calls BAPI with correct parameters", async () => {
    let capturedUrl: string | undefined;
    let capturedInit: RequestInit | undefined;

    stubFetch(async (input, init) => {
      capturedUrl = input.toString();
      capturedInit = init;
      return new Response(
        JSON.stringify({
          publishable_key: "pk_test_new",
          secret_key: "sk_test_new",
          claim_url: "/apps/claim?token=tok_123",
        }),
        { status: 201 },
      );
    });

    const result = await createAccountlessApp("nextjs");

    expect(capturedUrl).toContain("/v1/accountless_applications");
    expect(capturedInit?.method).toBe("POST");
    expect(new Headers(capturedInit?.headers).get("Clerk-Framework")).toBe("nextjs");
    expect(result.publishable_key).toBe("pk_test_new");
    expect(result.claim_url).toContain("tok_123");
  });

  test("omits Clerk-Framework header when no framework specified", async () => {
    let capturedHeaders: Headers | undefined;

    stubFetch(async (_input, init) => {
      capturedHeaders = new Headers(init?.headers);
      return new Response(
        JSON.stringify({
          publishable_key: "pk",
          secret_key: "sk",
          claim_url: "/apps/claim?token=t",
        }),
        { status: 201 },
      );
    });

    await createAccountlessApp();

    expect(capturedHeaders?.get("Clerk-Framework")).toBeNull();
  });

  test("throws BapiError on non-OK response", async () => {
    stubFetch(async () => new Response("Server Error", { status: 500 }));

    await expect(createAccountlessApp()).rejects.toMatchObject({
      name: "BapiError",
      status: 500,
    });
  });
});
