import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createIOSNativeRegistrationRetryStore,
  type IOSNativeRegistrationRetryIdentity,
} from "./native-registration-retry.ts";

const temporaryDirectories: string[] = [];

async function temporaryStateDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "clerk-ios-registration-retry-"));
  temporaryDirectories.push(directory);
  return directory;
}

function identity(
  overrides: Partial<IOSNativeRegistrationRetryIdentity> = {},
): IOSNativeRegistrationRetryIdentity {
  return {
    applicationId: "app_native_test",
    instanceId: "ins_native_development",
    bundleIdentifier: "com.example.NativeApp",
    appIdPrefix: "ABCDE12345",
    ...overrides,
  };
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("iOS native registration retry state", () => {
  test("atomically reuses one key across concurrent callers and store instances", async () => {
    const stateDirectory = await temporaryStateDirectory();
    const firstStore = createIOSNativeRegistrationRetryStore(() => stateDirectory);
    const secondStore = createIOSNativeRegistrationRetryStore(() => stateDirectory);
    const target = identity();

    const keys = await Promise.all([
      firstStore.getOrCreate(target),
      secondStore.getOrCreate(target),
      firstStore.getOrCreate(target),
      secondStore.getOrCreate(target),
    ]);

    expect(new Set(keys).size).toBe(1);
    expect(keys[0]).toStartWith("clerk-init-ios-registration-");
  });

  test("scopes pending operations to the complete remote registration identity", async () => {
    const stateDirectory = await temporaryStateDirectory();
    const store = createIOSNativeRegistrationRetryStore(() => stateDirectory);
    const target = identity();
    const first = await store.getOrCreate(target);

    for (const changed of [
      identity({ applicationId: "app_other" }),
      identity({ instanceId: "ins_other" }),
      identity({ bundleIdentifier: "com.example.Other" }),
      identity({ appIdPrefix: "OTHER12345" }),
    ]) {
      expect(await store.getOrCreate(changed)).not.toBe(first);
    }
  });

  test("clears a verified operation so a later registration receives a new key", async () => {
    const stateDirectory = await temporaryStateDirectory();
    const store = createIOSNativeRegistrationRetryStore(() => stateDirectory);
    const target = identity();
    const first = await store.getOrCreate(target);

    expect(await store.clear(target, first)).toBe(true);

    expect(await store.getOrCreate(target)).not.toBe(first);
  });

  test("does not let a delayed clear remove a newer registration generation", async () => {
    const stateDirectory = await temporaryStateDirectory();
    const store = createIOSNativeRegistrationRetryStore(() => stateDirectory);
    const target = identity();
    const first = await store.getOrCreate(target);
    expect(await store.clear(target, first)).toBe(true);
    const newer = await store.getOrCreate(target);

    expect(await store.clear(target, first)).toBe(false);
    expect(await store.peek(target)).toBe(newer);
  });

  test("retains an old pending operation until remote verification clears it", async () => {
    const stateDirectory = await temporaryStateDirectory();
    const store = createIOSNativeRegistrationRetryStore(() => stateDirectory);
    const target = identity();
    const first = await store.getOrCreate(target);
    const directory = join(stateDirectory, "idempotency");
    const [filename] = await readdir(directory);
    const path = join(directory, filename!);
    const record = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
    record.createdAt = "2000-01-01T00:00:00.000Z";
    await writeFile(path, `${JSON.stringify(record, null, 2)}\n`);

    expect(await store.getOrCreate(target)).toBe(first);
  });

  test("fails closed instead of replacing a malformed pending record", async () => {
    const stateDirectory = await temporaryStateDirectory();
    const store = createIOSNativeRegistrationRetryStore(() => stateDirectory);
    const target = identity();
    await store.getOrCreate(target);
    const directory = join(stateDirectory, "idempotency");
    const [filename] = await readdir(directory);
    await writeFile(join(directory, filename!), "{ malformed");

    await expect(store.getOrCreate(target)).rejects.toThrow("retry record is malformed");
  });

  test("fails closed without stealing an abandoned stale filesystem lock", async () => {
    const stateDirectory = await temporaryStateDirectory();
    const store = createIOSNativeRegistrationRetryStore(() => stateDirectory, {
      lockRetryMs: 1,
      lockTimeoutMs: 10,
      lockStaleMs: 5,
    });
    const target = identity();
    const first = await store.getOrCreate(target);
    const directory = join(stateDirectory, "idempotency");
    const [filename] = await readdir(directory);
    const lock = join(directory, `${filename!}.lock`);
    await mkdir(lock);
    const stale = new Date(Date.now() - 60_000);
    await utimes(lock, stale, stale);

    expect(first).toStartWith("clerk-init-ios-registration-");
    await expect(store.getOrCreate(target)).rejects.toThrow("lock is stale");
    expect(await readdir(lock)).toEqual([]);
  });
});
