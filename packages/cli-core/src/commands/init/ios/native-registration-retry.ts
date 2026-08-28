import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rmdir, unlink, writeFile } from "node:fs/promises";
import { setTimeout as sleep } from "node:timers/promises";
import { dirname, join } from "node:path";
import { getConfigFile } from "../../../lib/config.ts";
import { withHomeFsAccess } from "../../../lib/host-execution.ts";

const RETRY_DIRECTORY = "idempotency";
const RETRY_FILE_PREFIX = "ios-native-registration-";
const IDEMPOTENCY_KEY_PREFIX = "clerk-init-ios-registration-";
const IDEMPOTENCY_KEY_PATTERN =
  /^clerk-init-ios-registration-[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CONCURRENT_WRITE_ATTEMPTS = 20;
const CONCURRENT_WRITE_RETRY_MS = 5;

export interface IOSNativeRegistrationRetryIdentity {
  applicationId: string;
  instanceId: string;
  bundleIdentifier: string;
  appIdPrefix: string;
}

export interface IOSNativeRegistrationRetryStore {
  getOrCreate(identity: IOSNativeRegistrationRetryIdentity): Promise<string>;
  clear(identity: IOSNativeRegistrationRetryIdentity): Promise<void>;
}

interface IOSNativeRegistrationRetryRecord {
  schemaVersion: 1;
  kind: "clerk-ios-native-registration-retry";
  applicationId: string;
  instanceId: string;
  bundleIdentifier: string;
  appIdPrefix: string;
  idempotencyKey: string;
  createdAt: string;
}

function retryFingerprint(identity: IOSNativeRegistrationRetryIdentity): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        applicationId: identity.applicationId,
        instanceId: identity.instanceId,
        bundleIdentifier: identity.bundleIdentifier,
        appIdPrefix: identity.appIdPrefix,
      }),
    )
    .digest("hex")
    .slice(0, 24);
}

function retryDirectory(baseDirectory: string): string {
  return join(baseDirectory, RETRY_DIRECTORY);
}

function retryPath(baseDirectory: string, identity: IOSNativeRegistrationRetryIdentity): string {
  return join(
    retryDirectory(baseDirectory),
    `${RETRY_FILE_PREFIX}${retryFingerprint(identity)}.json`,
  );
}

function isMissingFile(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "ENOENT";
}

function isExistingFile(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "EEXIST";
}

function isRetryRecord(
  value: unknown,
  identity: IOSNativeRegistrationRetryIdentity,
): value is IOSNativeRegistrationRetryRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    record.schemaVersion === 1 &&
    record.kind === "clerk-ios-native-registration-retry" &&
    record.applicationId === identity.applicationId &&
    record.instanceId === identity.instanceId &&
    record.bundleIdentifier === identity.bundleIdentifier &&
    record.appIdPrefix === identity.appIdPrefix &&
    typeof record.idempotencyKey === "string" &&
    IDEMPOTENCY_KEY_PATTERN.test(record.idempotencyKey) &&
    typeof record.createdAt === "string" &&
    !Number.isNaN(Date.parse(record.createdAt))
  );
}

async function readRetryRecordOnce(
  baseDirectory: string,
  identity: IOSNativeRegistrationRetryIdentity,
): Promise<IOSNativeRegistrationRetryRecord | undefined> {
  const path = retryPath(baseDirectory, identity);
  let source: string;
  try {
    source = await readFile(path, "utf8");
  } catch (error) {
    if (isMissingFile(error)) return undefined;
    throw error;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch {
    throw new Error(`The Clerk iOS registration retry record is malformed: ${path}`);
  }
  if (!isRetryRecord(parsed, identity)) {
    throw new Error(`The Clerk iOS registration retry record has an unexpected shape: ${path}`);
  }
  return parsed;
}

async function readRetryRecord(
  baseDirectory: string,
  identity: IOSNativeRegistrationRetryIdentity,
): Promise<IOSNativeRegistrationRetryRecord | undefined> {
  let lastError: unknown;
  for (let attempt = 0; attempt < CONCURRENT_WRITE_ATTEMPTS; attempt += 1) {
    try {
      return await readRetryRecordOnce(baseDirectory, identity);
    } catch (error) {
      lastError = error;
      if (attempt + 1 < CONCURRENT_WRITE_ATTEMPTS) {
        await sleep(CONCURRENT_WRITE_RETRY_MS);
      }
    }
  }
  throw lastError;
}

async function getOrCreateRetryKey(
  baseDirectory: string,
  identity: IOSNativeRegistrationRetryIdentity,
): Promise<string> {
  const existing = await readRetryRecord(baseDirectory, identity);
  if (existing) return existing.idempotencyKey;

  const directory = retryDirectory(baseDirectory);
  const path = retryPath(baseDirectory, identity);
  await mkdir(directory, { recursive: true, mode: 0o700 });

  const record: IOSNativeRegistrationRetryRecord = {
    schemaVersion: 1,
    kind: "clerk-ios-native-registration-retry",
    applicationId: identity.applicationId,
    instanceId: identity.instanceId,
    bundleIdentifier: identity.bundleIdentifier,
    appIdPrefix: identity.appIdPrefix,
    idempotencyKey: `${IDEMPOTENCY_KEY_PREFIX}${randomUUID()}`,
    createdAt: new Date().toISOString(),
  };

  try {
    await writeFile(path, `${JSON.stringify(record, null, 2)}\n`, {
      flag: "wx",
      mode: 0o600,
    });
    return record.idempotencyKey;
  } catch (error) {
    if (!isExistingFile(error)) throw error;
    const concurrent = await readRetryRecord(baseDirectory, identity);
    if (!concurrent) {
      throw new Error("The Clerk iOS registration retry record disappeared during creation.");
    }
    return concurrent.idempotencyKey;
  }
}

async function clearRetryKey(
  baseDirectory: string,
  identity: IOSNativeRegistrationRetryIdentity,
): Promise<void> {
  try {
    await unlink(retryPath(baseDirectory, identity));
  } catch (error) {
    if (!isMissingFile(error)) throw error;
    return;
  }

  // Remove only the empty operational directory. Never remove other CLI state.
  try {
    await rmdir(retryDirectory(baseDirectory));
  } catch {
    // Another retry record is present, or another process started a retry.
  }
}

export function createIOSNativeRegistrationRetryStore(
  resolveBaseDirectory: () => string = () => dirname(getConfigFile()),
): IOSNativeRegistrationRetryStore {
  return {
    async getOrCreate(identity) {
      const baseDirectory = resolveBaseDirectory();
      const path = retryPath(baseDirectory, identity);
      return withHomeFsAccess(
        { operation: "write", target: path, label: "CLI idempotency state directory" },
        async () => getOrCreateRetryKey(baseDirectory, identity),
      );
    },
    async clear(identity) {
      const baseDirectory = resolveBaseDirectory();
      const path = retryPath(baseDirectory, identity);
      await withHomeFsAccess(
        { operation: "delete", target: path, label: "CLI idempotency state directory" },
        async () => clearRetryKey(baseDirectory, identity),
      );
    },
  };
}

export const cliStateIOSNativeRegistrationRetryStore = createIOSNativeRegistrationRetryStore();
