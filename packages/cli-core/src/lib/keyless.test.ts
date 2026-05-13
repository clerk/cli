import { test, expect, describe, beforeEach, afterEach, spyOn } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { stubFetch, useCaptureLog } from "../test/lib/stubs.ts";

const {
  parseClaimToken,
  writeKeylessBreadcrumb,
  readKeylessBreadcrumb,
  clearKeylessBreadcrumb,
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
  useCaptureLog();
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
    const result = await readKeylessBreadcrumb(tempDir);
    expect(result).toBeUndefined();
  });

  test("read returns undefined and clears file when breadcrumb has wrong shape", async () => {
    const breadcrumbFile = join(tempDir, ".clerk", "keyless.json");
    await Bun.write(breadcrumbFile, JSON.stringify({ claimToken: 12345, createdAt: "2024-01-01" }));
    const result = await readKeylessBreadcrumb(tempDir);
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

describe("writeKeysToEnvFile", () => {
  useCaptureLog();
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "clerk-keyless-env-test-"));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  test("writes keys to .env.local", async () => {
    await writeKeysToEnvFile(tempDir, {
      publishableKey: "pk_test_123",
      secretKey: "sk_test_456",
    });

    const content = await Bun.file(join(tempDir, ".env.local")).text();
    expect(content).toContain("CLERK_PUBLISHABLE_KEY=pk_test_123");
    expect(content).toContain("CLERK_SECRET_KEY=sk_test_456");
  });

  test("merges with existing env file content", async () => {
    await Bun.write(join(tempDir, ".env.local"), "EXISTING_VAR=hello\n");
    await writeKeysToEnvFile(tempDir, {
      publishableKey: "pk_test_abc",
      secretKey: "sk_test_def",
    });

    const content = await Bun.file(join(tempDir, ".env.local")).text();
    expect(content).toContain("EXISTING_VAR=hello");
    expect(content).toContain("CLERK_PUBLISHABLE_KEY=pk_test_abc");
  });

  test("uses framework-specific key names and env file when package.json specifies Next.js", async () => {
    await Bun.write(
      join(tempDir, "package.json"),
      JSON.stringify({ dependencies: { next: "latest" } }),
    );
    await writeKeysToEnvFile(tempDir, {
      publishableKey: "pk_test_next",
      secretKey: "sk_test_next",
    });

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
