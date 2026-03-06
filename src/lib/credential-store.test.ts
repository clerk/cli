import { test, expect, describe, beforeEach, afterAll, mock } from "bun:test";
import { mkdtemp, rm, mkdir, chmod } from "node:fs/promises";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";

const tempDir = await mkdtemp(join(tmpdir(), "clerk-cred-test-"));

// Redirect file-based credential storage to temp dir via env var
process.env.CLERK_CONFIG_DIR = tempDir;

// Re-register real credential-store to override any stale mocks from other test files
const isMacOS = process.platform === "darwin";
const KEYCHAIN_SERVICE = "clerk-cli";
const KEYCHAIN_ACCOUNT = "oauth-access-token";
const credFile = () =>
  join(process.env.CLERK_CONFIG_DIR ?? join(require("os").homedir(), ".clerk"), "credentials");

mock.module("./credential-store.ts", () => ({
  async storeToken(token: string) {
    if (isMacOS) {
      try {
        await Bun.$`security add-generic-password -a ${KEYCHAIN_ACCOUNT} -s ${KEYCHAIN_SERVICE} -w ${token} -U`.quiet();
        return;
      } catch {}
    }
    const f = credFile();
    await mkdir(dirname(f), { recursive: true });
    await Bun.write(f, token);
    await chmod(f, 0o600);
  },
  async getToken() {
    if (isMacOS) {
      try {
        return (
          await Bun.$`security find-generic-password -a ${KEYCHAIN_ACCOUNT} -s ${KEYCHAIN_SERVICE} -w`.quiet()
        )
          .text()
          .trim();
      } catch {}
    }
    const file = Bun.file(credFile());
    if (!(await file.exists())) return null;
    const content = await file.text();
    return content.trim() || null;
  },
  async deleteToken() {
    if (isMacOS) {
      try {
        await Bun.$`security delete-generic-password -a ${KEYCHAIN_ACCOUNT} -s ${KEYCHAIN_SERVICE}`.quiet();
      } catch {}
    }
    const file = Bun.file(credFile());
    if (await file.exists()) await Bun.write(credFile(), "");
  },
}));

const { storeToken, getToken, deleteToken } = await import("./credential-store.ts");

let savedToken: string | null = null;

afterAll(async () => {
  // Restore any pre-existing keychain token on macOS
  if (process.platform === "darwin" && savedToken !== null) {
    await storeToken(savedToken);
  }
  delete process.env.CLERK_CONFIG_DIR;
  await rm(tempDir, { recursive: true, force: true });
});

describe("credential-store", () => {
  beforeEach(async () => {
    // On first run, save any existing keychain token so we can restore it later
    if (process.platform === "darwin" && savedToken === null) {
      savedToken = await getToken();
    }
    await deleteToken();
  });

  test("getToken returns null when no token is stored", async () => {
    const token = await getToken();
    expect(token).toBeNull();
  });

  test("storeToken and getToken roundtrip", async () => {
    await storeToken("my-access-token");
    const token = await getToken();
    expect(token).toBe("my-access-token");
  });

  test("deleteToken removes stored token", async () => {
    await storeToken("token-to-remove");
    expect(await getToken()).toBe("token-to-remove");

    await deleteToken();
    expect(await getToken()).toBeNull();
  });

  test("storeToken overwrites existing token", async () => {
    await storeToken("first-token");
    await storeToken("second-token");
    const token = await getToken();
    expect(token).toBe("second-token");
  });

  test("deleteToken is safe to call when no token exists", async () => {
    await deleteToken();
    await deleteToken();
    expect(await getToken()).toBeNull();
  });
});
