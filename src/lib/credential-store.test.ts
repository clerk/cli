import { test, expect, describe, beforeEach, afterAll } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

const tempDir = await mkdtemp(join(tmpdir(), "clerk-cred-test-"));

// Redirect file-based credential storage to temp dir via env var
// (constants.ts reads CLERK_CONFIG_DIR before falling back to ~/.clerk)
process.env.CLERK_CONFIG_DIR = tempDir;

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
