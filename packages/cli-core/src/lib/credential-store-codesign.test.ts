/**
 * The release-build macOS path of the quiet credential check: on a cold
 * process it runs `codesign` asynchronously to pick the keychain namespace,
 * kills it when the signal aborts, and memoizes a completed answer for the
 * blocking read. Dev builds skip all of it, so this file mocks a release
 * version and puts a fake `codesign` script first on PATH: the real spawn and
 * the real kill run, on Linux CI too, since the platform is stubbed to macOS.
 *
 * Module mocks at file top, before any consumer loads the real modules.
 */

import { afterAll, beforeEach, expect, mock, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The fake is a `#!/bin/sh` script checked with a Unix signal, so the file
// cannot run on a Windows host. Captured before the tests stub the platform.
const HOST_IS_WINDOWS = process.platform === "win32";
const unixTest = test.skipIf(HOST_IS_WINDOWS);

const tempDir = await mkdtemp(join(tmpdir(), "clerk-codesign-test-"));
process.env.CLERK_CONFIG_DIR = tempDir;
const binDir = join(tempDir, "bin");
const emptyDir = join(tempDir, "empty");
await mkdir(binDir);
await mkdir(emptyDir);
/** One line per `codesign` invocation, appended by the fake script. */
const callLog = join(tempDir, "codesign-calls");
/** Written by the hanging fake before it sleeps. */
const pidFile = join(tempDir, "codesign-pid");

/** Which namespace each keychain read was asked for, by path. */
const services = { quiet: [] as string[], loud: [] as string[] };

mock.module("@napi-rs/keyring", () => ({
  Entry: class {
    constructor(service: string) {
      services.loud.push(service);
    }
    getPassword(): string | null {
      return null;
    }
    setPassword(): void {}
    deletePassword(): boolean {
      return false;
    }
  },
  AsyncEntry: class {
    constructor(service: string) {
      services.quiet.push(service);
    }
    async getPassword(): Promise<string | null> {
      return null;
    }
  },
}));

mock.module("./version.ts", () => ({
  CURRENT_VERSION: "1.0.0",
  IS_DEV_BUILD: false,
}));

const {
  _resetKeychainService,
  hasStoredCredentials,
  KEYCHAIN_SERVICE,
  LOCAL_DEV_KEYCHAIN_SERVICE,
  probeAccountCredentials,
} = await import("./credential-store.ts");

const originalPath = process.env.PATH;
const originalPlatform = process.platform;
const originalPlatformApiKey = process.env.CLERK_PLATFORM_API_KEY;

const SIGNED_OUTPUT = 'echo "Identifier=clerk"; echo "TeamIdentifier=L8SD6SB282"; exit 0';
const UNSIGNED_OUTPUT = 'echo "code object is not signed at all" >&2; exit 1';

async function installCodesign(body: string): Promise<void> {
  const script = join(binDir, "codesign");
  await writeFile(script, `#!/bin/sh\necho run >> "${callLog}"\n${body}\n`);
  await chmod(script, 0o755);
}

async function codesignRuns(): Promise<number> {
  const log = await readFile(callLog, "utf8").catch(() => "");
  return log.split("\n").filter(Boolean).length;
}

function processIsGone(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return false;
  } catch {
    return true;
  }
}

/**
 * Start the check against a `codesign` that writes its pid and then sleeps,
 * and return once that child is running, so the test aborts a process it
 * knows exists rather than one that may still be launching on a slow runner.
 */
async function startHangingCodesign(): Promise<{
  pending: Promise<boolean | null>;
  controller: AbortController;
  pid: number;
}> {
  await installCodesign(`echo $$ > "${pidFile}"; exec sleep 5`);
  const controller = new AbortController();
  const pending = probeAccountCredentials(controller.signal);
  const deadline = Date.now() + 2_000;
  let pid = 0;
  while (pid === 0 && Date.now() < deadline) {
    pid = Number((await readFile(pidFile, "utf8").catch(() => "")).trim());
    if (pid === 0) await Bun.sleep(10);
  }
  expect(pid).toBeGreaterThan(0);
  return { pending, controller, pid };
}

beforeEach(async () => {
  _resetKeychainService();
  services.quiet.length = 0;
  services.loud.length = 0;
  delete process.env.CLERK_PLATFORM_API_KEY;
  process.env.PATH = `${binDir}:${originalPath}`;
  Object.defineProperty(process, "platform", { value: "darwin", writable: true });
  await rm(callLog, { force: true });
  await rm(pidFile, { force: true });
});

afterAll(async () => {
  process.env.PATH = originalPath;
  Object.defineProperty(process, "platform", { value: originalPlatform, writable: true });
  if (originalPlatformApiKey === undefined) delete process.env.CLERK_PLATFORM_API_KEY;
  else process.env.CLERK_PLATFORM_API_KEY = originalPlatformApiKey;
  delete process.env.CLERK_CONFIG_DIR;
  await rm(tempDir, { recursive: true, force: true });
});

unixTest("a release-signed binary reads the release keychain namespace", async () => {
  await installCodesign(SIGNED_OUTPUT);
  expect(await probeAccountCredentials(AbortSignal.timeout(2_000))).toBe(false);
  expect(services.quiet).toEqual([KEYCHAIN_SERVICE]);
  expect(await codesignRuns()).toBe(1);
});

unixTest("an unsigned binary reads the local keychain namespace", async () => {
  await installCodesign(UNSIGNED_OUTPUT);
  expect(await probeAccountCredentials(AbortSignal.timeout(2_000))).toBe(false);
  expect(services.quiet).toEqual([LOCAL_DEV_KEYCHAIN_SERVICE]);
});

unixTest("a codesign that hangs is killed on abort and the check reads null", async () => {
  const { pending, controller, pid } = await startHangingCodesign();
  expect(processIsGone(pid)).toBe(false);

  const aborted = Date.now();
  controller.abort();
  expect(await pending).toBeNull();
  expect(Date.now() - aborted).toBeLessThan(1_000);
  expect(services.quiet).toEqual([]);

  // The abort kills the child; the check returns on the abort, not on the
  // exit, so the kill may still be landing.
  const deadline = Date.now() + 2_000;
  while (!processIsGone(pid) && Date.now() < deadline) {
    await Bun.sleep(10);
  }
  expect(processIsGone(pid)).toBe(true);
});

unixTest("a codesign that cannot be started reads null without throwing", async () => {
  process.env.PATH = emptyDir;
  expect(await probeAccountCredentials(AbortSignal.timeout(2_000))).toBeNull();
  expect(services.quiet).toEqual([]);
});

// The namespace resolved quietly is kept for the blocking read, so a command
// that reads credentials after the quiet check never runs `codesign` twice.
unixTest("a completed quiet resolution is reused by the blocking read", async () => {
  await installCodesign(SIGNED_OUTPUT);
  expect(await probeAccountCredentials(AbortSignal.timeout(2_000))).toBe(false);
  expect(await hasStoredCredentials()).toBe(false);
  expect(services.loud).toEqual([KEYCHAIN_SERVICE]);
  expect(await codesignRuns()).toBe(1);
});

// A resolution cut short is not kept: the blocking read inspects for itself.
unixTest("an aborted quiet resolution is not reused", async () => {
  const { pending, controller } = await startHangingCodesign();
  controller.abort();
  expect(await pending).toBeNull();
  await installCodesign(SIGNED_OUTPUT);
  expect(await hasStoredCredentials()).toBe(false);
  expect(services.loud).toEqual([KEYCHAIN_SERVICE]);
  expect(await codesignRuns()).toBe(2);
});
