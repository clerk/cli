import { test, expect, describe, beforeEach, afterAll, mock } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

const tempDir = await mkdtemp(join(tmpdir(), "clerk-cred-test-"));
const uniqueId = `test-${Date.now()}`;

mock.module("./constants.ts", () => ({
  CREDENTIALS_FILE: join(tempDir, "credentials"),
  KEYCHAIN_SERVICE: `clerk-cli-${uniqueId}`,
  KEYCHAIN_ACCOUNT: `account-${uniqueId}`,
}));

const { storeToken, getToken, deleteToken } = await import("./credential-store.ts");

afterAll(async () => {
  await rm(tempDir, { recursive: true, force: true });
  if (process.platform === "darwin") {
    try {
      await Bun.$`security delete-generic-password -a account-${uniqueId} -s clerk-cli-${uniqueId}`.quiet();
    } catch {
      // Entry may not exist
    }
  }
});

describe("credential-store", () => {
  beforeEach(async () => {
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
