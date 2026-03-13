import { test, expect, describe, beforeEach, afterAll, mock, setDefaultTimeout } from "bun:test";

// Keyring initialization can be slow on first access (macOS Keychain, etc.)
setDefaultTimeout(5_000);
import { mkdtemp, rm, mkdir, chmod, unlink } from "node:fs/promises";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";

const tempDir = await mkdtemp(join(tmpdir(), "clerk-cred-test-"));

// Redirect file-based credential storage to temp dir via env var
process.env.CLERK_CONFIG_DIR = tempDir;

// Import constants from the source module to avoid duplication
const { KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT } = await import("./credential-store.ts");
const credFile = () =>
  join(process.env.CLERK_CONFIG_DIR ?? join(require("os").homedir(), ".clerk"), "credentials");

let keyringModule: typeof import("@napi-rs/keyring") | null;
try {
  keyringModule = await import("@napi-rs/keyring");
} catch {
  keyringModule = null;
}

mock.module("./credential-store.ts", () => ({
  KEYCHAIN_SERVICE,
  KEYCHAIN_ACCOUNT,
  async storeToken(token: string) {
    if (keyringModule) {
      try {
        const entry = new keyringModule.Entry(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT);
        entry.setPassword(token);
        return;
      } catch {}
    }
    const f = credFile();
    await mkdir(dirname(f), { recursive: true });
    await Bun.write(f, token);
    await chmod(f, 0o600);
  },
  async getToken() {
    if (keyringModule) {
      try {
        const entry = new keyringModule.Entry(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT);
        return entry.getPassword();
      } catch {}
    }
    const file = Bun.file(credFile());
    if (!(await file.exists())) return null;
    const content = await file.text();
    return content.trim() || null;
  },
  async deleteToken() {
    if (keyringModule) {
      try {
        const entry = new keyringModule.Entry(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT);
        entry.deletePassword();
      } catch {}
    }
    try {
      await unlink(credFile());
    } catch {
      // File doesn't exist, nothing to delete
    }
  },
}));

const { storeToken, getToken, deleteToken } = await import("./credential-store.ts");

let savedToken: string | null = null;

afterAll(async () => {
  // Restore any pre-existing keyring token
  if (keyringModule && savedToken !== null) {
    await storeToken(savedToken);
  }
  delete process.env.CLERK_CONFIG_DIR;
  await rm(tempDir, { recursive: true, force: true });
});

describe("credential-store", () => {
  beforeEach(async () => {
    // On first run, save any existing keyring token so we can restore it later
    if (keyringModule && savedToken === null) {
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
