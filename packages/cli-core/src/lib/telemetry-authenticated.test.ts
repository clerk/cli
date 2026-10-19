/**
 * The `authenticated` telemetry field against a controllable credential store:
 * a fake keyring (so reads can be made to find a session, find nothing, fail
 * or hang, and deletes can be made to fail) and a credentials file under a
 * temp `CLERK_CONFIG_DIR`. telemetry.test.ts pins the field with the token
 * override; this file covers what only a real store path shows: the fresh
 * read on sign-in and sign-out, the platform split on a failed keyring read,
 * and the budget. The release-build `codesign` path is in
 * credential-store-codesign.test.ts.
 *
 * Module mocks at file top, before any consumer loads the real modules.
 */

import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdtemp, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tempDir = await mkdtemp(join(tmpdir(), "clerk-telemetry-auth-test-"));
// Read at module load by constants.ts: isolates the credentials file, the
// config file (machine uuid, notice flag) and the sandbox probe targets.
process.env.CLERK_CONFIG_DIR = tempDir;
const credentialsFile = join(tempDir, "credentials");

/** State the fake keyring reads; tests set it directly. */
const keyring = {
  entries: new Map<string, string>(),
  /** Every read rejects (a locked store, or a sandbox denying access). */
  failReads: false,
  /** Every quiet read waits until its signal aborts. */
  hangReads: false,
  /** Every delete throws, leaving the entry in place. */
  failDeletes: false,
  /** How many quiet (AsyncEntry) reads have run. */
  asyncReads: 0,
};

/** The one entry a dev build on macOS reads for the production environment. */
const DEV_ENTRY = "clerk-cli-dev/oauth-access-token";

function resetKeyring(): void {
  keyring.entries.clear();
  keyring.failReads = false;
  keyring.hangReads = false;
  keyring.failDeletes = false;
  keyring.asyncReads = 0;
}

mock.module("@napi-rs/keyring", () => ({
  Entry: class {
    key: string;
    constructor(service: string, account: string) {
      this.key = `${service}/${account}`;
    }
    getPassword(): string | null {
      if (keyring.failReads) throw new Error("keyring entry is locked");
      return keyring.entries.get(this.key) ?? null;
    }
    setPassword(value: string): void {
      keyring.entries.set(this.key, value);
    }
    deletePassword(): boolean {
      if (keyring.failDeletes) throw new Error("keyring entry is locked");
      return keyring.entries.delete(this.key);
    }
  },
  AsyncEntry: class {
    key: string;
    constructor(service: string, account: string) {
      this.key = `${service}/${account}`;
    }
    async getPassword(signal?: AbortSignal | null): Promise<string | null> {
      keyring.asyncReads += 1;
      if (keyring.hangReads) {
        return new Promise((_resolve, reject) => {
          const fail = () => reject(new DOMException("The operation was aborted.", "AbortError"));
          if (!signal) return;
          if (signal.aborted) return fail();
          signal.addEventListener("abort", fail, { once: true });
        });
      }
      if (keyring.failReads) throw new Error("keyring entry is locked");
      return keyring.entries.get(this.key) ?? null;
    }
  },
}));

mock.module("./version.ts", () => ({
  CURRENT_VERSION: "0.0.0-dev",
  IS_DEV_BUILD: true,
}));

mock.module("./token-exchange.ts", () => ({
  refreshAccessToken: async () => {
    throw new Error("not under test");
  },
  revokeToken: async () => "revoked" as const,
}));

const {
  _setTokenOverride,
  deleteToken,
  probeAccountCredentials,
  revokeAndDeleteToken,
  storeToken,
} = await import("./credential-store.ts");
const { captureTelemetryPayload } = await import("../test/lib/stubs.ts");
const { TELEMETRY_CREDENTIAL_CHECK_MS } = await import("./constants.ts");

const SESSION = {
  accessToken: "access-token",
  refreshToken: "refresh-token",
  expiresAt: Date.now() + 60_000,
  tokenType: "Bearer",
};

const originalPlatform = process.platform;
const originalPlatformApiKey = process.env.CLERK_PLATFORM_API_KEY;

function setPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, "platform", { value: platform, writable: true });
}

/** The quiet check under the budget telemetry gives it. */
async function quietCheck(): Promise<boolean | null> {
  return probeAccountCredentials(AbortSignal.timeout(TELEMETRY_CREDENTIAL_CHECK_MS));
}

/** The `authenticated` value of the one event a run sends. */
async function authenticatedInEvent(run: () => void | Promise<void> = () => {}) {
  const { payload } = await captureTelemetryPayload("list", run, {
    result: { outcome: "success", exitCode: 0 },
    realCredentialStore: true,
  });
  return payload.authenticated;
}

beforeEach(async () => {
  resetKeyring();
  delete process.env.CLERK_PLATFORM_API_KEY;
  setPlatform("darwin");
  await unlink(credentialsFile).catch(() => {});
  _setTokenOverride(undefined);
});

afterEach(() => {
  setPlatform(originalPlatform);
});

afterAll(async () => {
  if (originalPlatformApiKey === undefined) delete process.env.CLERK_PLATFORM_API_KEY;
  else process.env.CLERK_PLATFORM_API_KEY = originalPlatformApiKey;
  delete process.env.CLERK_CONFIG_DIR;
  await rm(tempDir, { recursive: true, force: true });
});

describe("the fresh quiet read", () => {
  test("finds a keyring session", async () => {
    await storeToken(SESSION);
    expect(await quietCheck()).toBe(true);
    expect(keyring.asyncReads).toBe(1);
  });

  test("finds a file session when the keyring holds nothing", async () => {
    await writeFile(credentialsFile, JSON.stringify(SESSION), { mode: 0o600 });
    expect(await quietCheck()).toBe(true);
  });

  test("confirms absence when the keyring and the file hold nothing", async () => {
    expect(await quietCheck()).toBe(false);
  });

  test("never touches the keyring when the platform API key is set", async () => {
    process.env.CLERK_PLATFORM_API_KEY = "ak_test_quiet";
    keyring.failReads = true;
    expect(await quietCheck()).toBe(true);
    expect(keyring.asyncReads).toBe(0);
  });

  // Nothing is remembered across reads, so an answer nobody confirmed is
  // never repeated: the next check reads the store again.
  test("an unreadable keychain is read again on the next check", async () => {
    keyring.failReads = true;
    expect(await quietCheck()).toBeNull();
    keyring.failReads = false;
    keyring.entries.set(DEV_ENTRY, JSON.stringify(SESSION));
    expect(await quietCheck()).toBe(true);
    expect(keyring.asyncReads).toBe(2);
  });
});

// A keyring that rejects the read. On macOS and Windows a backend always
// exists, so a rejection means unreadable: the file decides, and an absent
// file is `null`, never `false`. On Linux a rejection is where "no keyring
// backend" lives, so the file is the whole store and an absent file is `false`.
describe("a failed keyring read splits by platform", () => {
  test.each([
    ["darwin", false, null],
    ["darwin", true, true],
    ["win32", false, null],
    ["win32", true, true],
    ["linux", false, false],
    ["linux", true, true],
  ] as [NodeJS.Platform, boolean, boolean | null][])(
    "on %s with a file session=%p the event carries %p",
    async (platform, fileSession, expected) => {
      setPlatform(platform);
      keyring.failReads = true;
      if (fileSession) {
        await writeFile(credentialsFile, JSON.stringify(SESSION), { mode: 0o600 });
      }
      expect(await authenticatedInEvent()).toBe(expected);
    },
  );
});

describe("the budget", () => {
  test("a hung keyring read yields null within the budget, and the event still sends", async () => {
    keyring.hangReads = true;
    const started = Date.now();
    expect(await authenticatedInEvent()).toBeNull();
    const elapsed = Date.now() - started;
    expect(elapsed).toBeGreaterThanOrEqual(TELEMETRY_CREDENTIAL_CHECK_MS - 20);
    expect(elapsed).toBeLessThan(TELEMETRY_CREDENTIAL_CHECK_MS + 400);
  });

  // The credentials file read cannot observe a signal, so the check races
  // against the abort itself rather than relying on the caller to.
  test("an aborted signal resolves null at once", async () => {
    keyring.hangReads = true;
    const controller = new AbortController();
    const pending = probeAccountCredentials(controller.signal);
    controller.abort();
    const started = Date.now();
    expect(await pending).toBeNull();
    expect(Date.now() - started).toBeLessThan(TELEMETRY_CREDENTIAL_CHECK_MS);
  });
});

// Every event reads the store afresh at the end of the run, so what the
// commands that change credentials wrote is what the event reports, and so
// is what another process changed meanwhile.
describe("read at the end of the run", () => {
  test("a sign-in: the value reads false, storeToken runs, and the event carries true", async () => {
    expect(await quietCheck()).toBe(false);
    await storeToken(SESSION);
    expect(await authenticatedInEvent()).toBe(true);
  });

  test("a sign-out: a fresh read confirms absence and the event carries false", async () => {
    await storeToken(SESSION);
    expect(await quietCheck()).toBe(true);
    expect(await revokeAndDeleteToken()).toBe("revoked");
    expect(await authenticatedInEvent()).toBe(false);
  });

  // `deleteToken` ignores what the keychain delete returns, so a "successful"
  // sign-out can leave the session in place. Reading afresh is what makes the
  // event tell the truth here.
  test("a keychain delete that fails leaves the entry, and the event carries true", async () => {
    await storeToken(SESSION);
    keyring.failDeletes = true;
    await deleteToken();
    expect(await authenticatedInEvent()).toBe(true);
  });

  test("a session removed behind the CLI's back during the run reads false", async () => {
    await storeToken(SESSION);
    expect(await quietCheck()).toBe(true);
    keyring.entries.delete(DEV_ENTRY); // another process signed out
    expect(await authenticatedInEvent()).toBe(false);
  });

  test("a sign-out after which the fresh read fails carries null", async () => {
    await storeToken(SESSION);
    await deleteToken();
    keyring.failReads = true;
    expect(await authenticatedInEvent()).toBeNull();
  });

  test("a sign-out after which the fresh read times out carries null", async () => {
    await storeToken(SESSION);
    await deleteToken();
    keyring.hangReads = true;
    expect(await authenticatedInEvent()).toBeNull();
  });
});
