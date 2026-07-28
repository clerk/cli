import { test, expect, describe, beforeEach, afterEach, spyOn } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { useCaptureLog } from "../test/lib/stubs.ts";

const configModule = await import("./config.ts");
const credentialStoreModule = await import("./credential-store.ts");
const bapiModule = await import("./bapi.ts");

const { resolveKeylessTarget, resolveInstanceTarget, hasKeyPairMismatch } =
  await import("./keyless-target.ts");

/** Encodes `<host>.clerk.accounts.dev$` the way a real publishable key would. */
function encodeFapiHost(host: string): string {
  return `pk_test_${Buffer.from(`${host}.clerk.accounts.dev$`).toString("base64").replace(/=+$/, "")}`;
}

describe("keyless-target", () => {
  let resolveProfileSpy: ReturnType<typeof spyOn>;
  let hasAccountCredentialsSpy: ReturnType<typeof spyOn>;
  let getStoredSessionSpy: ReturnType<typeof spyOn>;
  let bapiRequestSpy: ReturnType<typeof spyOn>;
  const originalEnv = { ...process.env };
  const captured = useCaptureLog();
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "clerk-keyless-target-"));
    resolveProfileSpy = spyOn(configModule, "resolveProfile").mockResolvedValue(undefined);
    hasAccountCredentialsSpy = spyOn(
      credentialStoreModule,
      "hasAccountCredentials",
    ).mockResolvedValue(false);
    getStoredSessionSpy = spyOn(credentialStoreModule, "getStoredSession").mockResolvedValue(null);
    bapiRequestSpy = spyOn(bapiModule, "bapiRequest");
  });

  afterEach(async () => {
    process.env = { ...originalEnv };
    resolveProfileSpy.mockRestore();
    hasAccountCredentialsSpy.mockRestore();
    getStoredSessionSpy.mockRestore();
    bapiRequestSpy.mockRestore();
    await rm(tempDir, { recursive: true, force: true });
  });

  describe("hasKeyPairMismatch", () => {
    const KEYLESS = { secretKey: "sk_test_x", source: ".env.local" };
    const MATCHING_PK = encodeFapiHost("match");
    const MISMATCHED_PK = encodeFapiHost("other");

    test("resolves false when the publishable key's host is among the secret key's own domains", async () => {
      bapiRequestSpy.mockResolvedValue({
        body: { data: [{ frontend_api_url: "https://match.clerk.accounts.dev" }] },
      });

      await expect(hasKeyPairMismatch(KEYLESS, MATCHING_PK)).resolves.toBe(false);
    });

    test("resolves true when the publishable key names a different application's host", async () => {
      bapiRequestSpy.mockResolvedValue({
        body: { data: [{ frontend_api_url: "https://match.clerk.accounts.dev" }] },
      });

      await expect(hasKeyPairMismatch(KEYLESS, MISMATCHED_PK)).resolves.toBe(true);
    });

    test("matches against any of several domains, not just the first", async () => {
      bapiRequestSpy.mockResolvedValue({
        body: {
          data: [
            { frontend_api_url: "https://unrelated.clerk.accounts.dev" },
            { frontend_api_url: "https://match.clerk.accounts.dev" },
          ],
        },
      });

      await expect(hasKeyPairMismatch(KEYLESS, MATCHING_PK)).resolves.toBe(false);
    });

    test("resolves false for a malformed publishable key rather than reporting a mismatch", async () => {
      await expect(hasKeyPairMismatch(KEYLESS, "not_a_publishable_key")).resolves.toBe(false);
      // A malformed key can't be decoded, so there was nothing to check against BAPI for.
      expect(bapiRequestSpy).not.toHaveBeenCalled();
    });

    test("resolves false when BAPI returns an unexpected shape rather than blocking on it", async () => {
      bapiRequestSpy.mockResolvedValue({ body: { data: "not-an-array" } });

      await expect(hasKeyPairMismatch(KEYLESS, MATCHING_PK)).resolves.toBe(false);
    });

    test("propagates a BAPI failure so callers can decide how strict to be", async () => {
      bapiRequestSpy.mockRejectedValue(new Error("network down"));

      await expect(hasKeyPairMismatch(KEYLESS, MATCHING_PK)).rejects.toThrow("network down");
    });
  });

  // The warning that the keyless view covers less belongs to the config
  // surface, so it hangs off `resolveInstanceTarget` — the resolver itself
  // stays silent for `whoami`, `open`, `env pull` and `doctor`.
  describe("resolveInstanceTarget — not-linked warning", () => {
    const session = (expiresAt: number) => ({
      accessToken: "at",
      refreshToken: "rt",
      expiresAt,
      tokenType: "Bearer" as const,
    });

    beforeEach(() => {
      process.env.CLERK_SECRET_KEY = "sk_test_x";
    });

    afterEach(() => {
      delete process.env.CLERK_SECRET_KEY;
      delete process.env.CLERK_PLATFORM_API_KEY;
    });

    test("resolving a target on its own never warns", async () => {
      hasAccountCredentialsSpy.mockResolvedValue(true);
      getStoredSessionSpy.mockResolvedValue(session(Date.now() - 60_000));

      await resolveKeylessTarget({ cwd: tempDir });

      expect(captured.err).toBe("");
    });

    test("no warning at all when there are no account credentials", async () => {
      await resolveInstanceTarget({ cwd: tempDir });

      expect(captured.err).toBe("");
    });

    test("points at `clerk link` when the stored session isn't locally expired", async () => {
      hasAccountCredentialsSpy.mockResolvedValue(true);
      getStoredSessionSpy.mockResolvedValue(session(Date.now() + 60_000));

      await resolveInstanceTarget({ cwd: tempDir });

      expect(captured.err).toContain("isn't linked to an application");
      expect(captured.err).toContain("Run `clerk link`");
      expect(captured.err).not.toContain("session has expired");
    });

    test("points at `clerk auth login` first when the stored session has locally expired", async () => {
      hasAccountCredentialsSpy.mockResolvedValue(true);
      getStoredSessionSpy.mockResolvedValue(session(Date.now() - 60_000));

      await resolveInstanceTarget({ cwd: tempDir });

      expect(captured.err).toContain("stored session has expired");
      expect(captured.err).toContain("Run `clerk auth login` to re-authenticate");
    });

    test("uses the `clerk link` wording for a platform API key, which never locally expires", async () => {
      hasAccountCredentialsSpy.mockResolvedValue(true);
      getStoredSessionSpy.mockResolvedValue(null);
      process.env.CLERK_PLATFORM_API_KEY = "ak_test_platform";

      await resolveInstanceTarget({ cwd: tempDir });

      expect(captured.err).toContain("isn't linked to an application");
      expect(captured.err).not.toContain("session has expired");
    });

    // `clerk link` accepts a platform API key on its own, so a leftover expired
    // OAuth session alongside one must not send the user to log in again.
    test("a platform API key wins over a stale stored session", async () => {
      hasAccountCredentialsSpy.mockResolvedValue(true);
      getStoredSessionSpy.mockResolvedValue(session(Date.now() - 60_000));
      process.env.CLERK_PLATFORM_API_KEY = "ak_test_platform";

      await resolveInstanceTarget({ cwd: tempDir });

      expect(captured.err).toContain("Run `clerk link`");
      expect(captured.err).not.toContain("session has expired");
    });
  });
});
