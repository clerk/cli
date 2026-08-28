import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
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

    await store.clear(target);

    expect(await store.getOrCreate(target)).not.toBe(first);
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
});
