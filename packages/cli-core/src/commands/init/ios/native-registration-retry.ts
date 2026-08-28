import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, rmdir, unlink, writeFile } from "node:fs/promises";
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
const LOCK_RETRY_MS = 10;
const LOCK_TIMEOUT_MS = 5_000;
const LOCK_STALE_MS = 30_000;

interface IOSNativeRegistrationRetryStoreOptions {
  lockRetryMs?: number;
  lockTimeoutMs?: number;
  lockStaleMs?: number;
}

export interface IOSNativeRegistrationRetryIdentity {
  applicationId: string;
  instanceId: string;
  bundleIdentifier: string;
  appIdPrefix: string;
}

export interface IOSNativeRegistrationRetryStore {
  getOrCreate(identity: IOSNativeRegistrationRetryIdentity): Promise<string>;
  peek(identity: IOSNativeRegistrationRetryIdentity): Promise<string | undefined>;
  clear(identity: IOSNativeRegistrationRetryIdentity, expectedKey: string): Promise<boolean>;
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

function lockPath(baseDirectory: string, identity: IOSNativeRegistrationRetryIdentity): string {
  return `${retryPath(baseDirectory, identity)}.lock`;
}

async function acquireLock(
  baseDirectory: string,
  identity: IOSNativeRegistrationRetryIdentity,
  options: Required<IOSNativeRegistrationRetryStoreOptions>,
): Promise<string> {
  await mkdir(retryDirectory(baseDirectory), { recursive: true, mode: 0o700 });
  const path = lockPath(baseDirectory, identity);
  const deadline = Date.now() + options.lockTimeoutMs;
  while (true) {
    try {
      await mkdir(path, { mode: 0o700 });
      return path;
    } catch (error) {
      if (!isExistingFile(error)) throw error;
      if (Date.now() >= deadline) {
        let stale = false;
        try {
          stale = Date.now() - (await lstat(path)).mtimeMs >= options.lockStaleMs;
        } catch (statError) {
          if (isMissingFile(statError)) continue;
          throw statError;
        }
        throw new Error(
          stale
            ? `The Clerk iOS registration retry-state lock is stale and was left in place for safety: ${path}`
            : "Timed out waiting for the Clerk iOS registration retry-state lock.",
        );
      }
      await sleep(options.lockRetryMs);
    }
  }
}

async function withIdentityLock<T>(
  baseDirectory: string,
  identity: IOSNativeRegistrationRetryIdentity,
  options: Required<IOSNativeRegistrationRetryStoreOptions>,
  operation: () => Promise<T>,
): Promise<T> {
  const path = await acquireLock(baseDirectory, identity, options);
  const release = async () => {
    try {
      await rmdir(path);
    } catch (error) {
      if (!isMissingFile(error)) throw error;
    }
  };
  try {
    const result = await operation();
    await release();
    return result;
  } catch (operationError) {
    try {
      await release();
    } catch (releaseError) {
      throw new AggregateError(
        [operationError, releaseError],
        "The Clerk iOS registration retry operation and lock release both failed.",
      );
    }
    throw operationError;
  }
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
  expectedKey: string,
): Promise<boolean> {
  const existing = await readRetryRecord(baseDirectory, identity);
  if (!existing) return true;
  if (existing.idempotencyKey !== expectedKey) return false;
  try {
    await unlink(retryPath(baseDirectory, identity));
  } catch (error) {
    if (!isMissingFile(error)) throw error;
    return true;
  }
  return true;
}

export function createIOSNativeRegistrationRetryStore(
  resolveBaseDirectory: () => string = () => dirname(getConfigFile()),
  options: IOSNativeRegistrationRetryStoreOptions = {},
): IOSNativeRegistrationRetryStore {
  const lockOptions: Required<IOSNativeRegistrationRetryStoreOptions> = {
    lockRetryMs: options.lockRetryMs ?? LOCK_RETRY_MS,
    lockTimeoutMs: options.lockTimeoutMs ?? LOCK_TIMEOUT_MS,
    lockStaleMs: options.lockStaleMs ?? LOCK_STALE_MS,
  };
  return {
    async getOrCreate(identity) {
      const baseDirectory = resolveBaseDirectory();
      const path = retryPath(baseDirectory, identity);
      return withHomeFsAccess(
        { operation: "write", target: path, label: "CLI idempotency state directory" },
        async () =>
          withIdentityLock(baseDirectory, identity, lockOptions, async () =>
            getOrCreateRetryKey(baseDirectory, identity),
          ),
      );
    },
    async peek(identity) {
      const baseDirectory = resolveBaseDirectory();
      const path = retryPath(baseDirectory, identity);
      return withHomeFsAccess(
        { operation: "read", target: path, label: "CLI idempotency state directory" },
        async () =>
          withIdentityLock(
            baseDirectory,
            identity,
            lockOptions,
            async () => (await readRetryRecord(baseDirectory, identity))?.idempotencyKey,
          ),
      );
    },
    async clear(identity, expectedKey) {
      const baseDirectory = resolveBaseDirectory();
      const path = retryPath(baseDirectory, identity);
      return withHomeFsAccess(
        { operation: "delete", target: path, label: "CLI idempotency state directory" },
        async () =>
          withIdentityLock(baseDirectory, identity, lockOptions, async () =>
            clearRetryKey(baseDirectory, identity, expectedKey),
          ),
      );
    },
  };
}

export const cliStateIOSNativeRegistrationRetryStore = createIOSNativeRegistrationRetryStore();
