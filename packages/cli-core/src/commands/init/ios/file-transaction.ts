import {
  link,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  rmdir,
} from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";

/**
 * The exact root and parent directory authorized while preparing a mutation.
 *
 * @internal Paths are canonical filesystem evidence and must not be serialized
 * into plans or included in CLI output or telemetry.
 */
export interface IOSFileMutationBoundary {
  rootPath: string;
  realRootPath: string;
  rootIdentity: { device: number; inode: number };
  realParentPath: string;
  parentIdentity: { device: number; inode: number };
}

/**
 * An already-inspected existing file and its validated replacement bytes.
 *
 * @internal This contains candidate bytes and must never be included in CLI
 * output, telemetry, serialized plans, or public errors/results.
 */
export interface IOSExistingFileMutation {
  path: string;
  boundary: IOSFileMutationBoundary;
  originalBytes: Uint8Array;
  originalHash: string;
  candidateBytes: Uint8Array;
  candidateHash: string;
  mode: number;
}

/**
 * An already-inspected absent path and the validated bytes to create there.
 *
 * @internal This contains candidate bytes and must never be included in CLI
 * output, telemetry, serialized plans, or public errors/results.
 */
export interface IOSCreateFileMutation {
  kind: "create";
  path: string;
  boundary: IOSFileMutationBoundary;
  candidateBytes: Uint8Array;
  candidateHash: string;
  mode: number;
}

export type IOSFileMutation = IOSExistingFileMutation | IOSCreateFileMutation;

export type IOSFilePostcondition = () => boolean | Promise<boolean>;

export type IOSFileTransactionResult =
  | { status: "applied" }
  | { status: "stale" }
  | { status: "rolled-back" };

export type IOSFileTransactionErrorCode =
  | "invalid-mutation"
  | "stage-failed"
  | "cleanup-failed"
  | "commit-failed"
  | "rollback-failed"
  | "recovery-failed";

/** A fixed-message failure that never carries mutation contents. */
export class IOSFileTransactionError extends Error {
  constructor(
    readonly code: IOSFileTransactionErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "IOSFileTransactionError";
  }
}

interface StagedMutation {
  mutation: IOSFileMutation;
  temporaryPath: string;
  temporaryPresent: boolean;
  stagedIdentity: FileIdentity;
  committedIdentity?: FileIdentity;
  claimedOriginal?: ClaimedDestination;
  originalClaimPath?: string;
  rollbackClaimPath?: string;
  recoveryDirectory?: {
    path: string;
    present: boolean;
    identity: DirectoryIdentity;
  };
}

interface ClaimedDestination {
  path: string;
  present: boolean;
  identity: FileIdentity;
}

interface FileIdentity {
  dev: number;
  ino: number;
  mode: number;
}

interface DirectoryIdentity {
  device: number;
  inode: number;
}

interface IOSFileTransactionJournalMutation {
  kind: "create" | "existing";
  destinationPath: string;
  temporaryPath: string;
  originalClaimPath?: string;
  rollbackClaimPath: string;
  originalHash?: string;
  candidateHash: string;
  mode: number;
  boundary: IOSFileMutationBoundary;
  recoveryDirectoryPath: string;
  recoveryDirectoryIdentity: DirectoryIdentity;
}

interface IOSFileTransactionJournalRecord {
  schemaVersion: 1;
  kind: "clerk-ios-file-transaction";
  transactionId: string;
  processId: number;
  rootPath: string;
  state: "pending" | "committed";
  mutations: IOSFileTransactionJournalMutation[];
}

interface IOSFileTransactionJournal {
  path: string;
  nextPath: string;
  record: IOSFileTransactionJournalRecord;
  present: boolean;
  identity?: FileIdentity;
  hash?: string;
}

class IOSFileTransactionStaleError extends Error {}

class IOSFileTransactionOwnershipError extends Error {}

class IOSFileTransactionUnsafeSetupCleanupError extends Error {
  constructor(cause: unknown) {
    super("iOS file transaction recovery setup could not be cleaned up safely", { cause });
  }
}

const JOURNAL_PREFIX = ".clerk-ios-file-transaction-";
const JOURNAL_SUFFIX = ".journal";
const MAX_JOURNAL_BYTES = 1_000_000;
const activeJournalPaths = new Set<string>();
const recoveryByRoot = new Map<string, Promise<void>>();
const rootLockContext = new AsyncLocalStorage<ReadonlySet<string>>();
const JOURNAL_NAME_PATTERN =
  /^\.clerk-ios-file-transaction-([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.journal$/i;
const ROOT_LOCK_DIRECTORY_NAME = `.clerk-ios-file-transaction-locks-${
  typeof process.getuid === "function" ? process.getuid() : "user"
}`;

/**
 * Deterministic race hooks used only by the file-transaction regression tests.
 *
 * @internal
 */
export interface IOSFileTransactionTestHooks {
  beforeRootLockPublication?: (path: string, temporaryPath: string) => void | Promise<void>;
  beforeRecoveryJournalPublication?: (path: string, temporaryPath: string) => void | Promise<void>;
  afterInitialRecoveryJournalPublication?: (journalPath: string) => void | Promise<void>;
  afterRecoveryJournalPublished?: (journalPath: string) => void | Promise<void>;
  afterDurableCommit?: (journalPath: string) => void | Promise<void>;
  afterCommittedArtifactCleanup?: (journalPath: string) => void | Promise<void>;
  beforeExistingDestinationClaim?: (path: string) => void | Promise<void>;
  afterExistingDestinationClaim?: (path: string, claimPath: string) => void | Promise<void>;
  beforeExistingDestinationInstall?: (path: string, claimPath: string) => void | Promise<void>;
  afterExistingDestinationInstall?: (path: string, claimPath: string) => void | Promise<void>;
  beforeRollbackDestinationClaim?: (path: string) => void | Promise<void>;
  afterRollbackDestinationClaim?: (path: string, claimPath: string) => void | Promise<void>;
  beforeRollbackDestinationInstall?: (
    path: string,
    originalSourcePath: string,
    candidateClaimPath: string,
  ) => void | Promise<void>;
  afterRollbackDestinationInstall?: (path: string) => void | Promise<void>;
}

export function hashIOSFileBytes(value: string | Uint8Array): string {
  return new Bun.CryptoHasher("sha256").update(value).digest("hex");
}

function transactionError(
  code: IOSFileTransactionErrorCode,
  message: string,
  cause?: unknown,
): IOSFileTransactionError {
  return new IOSFileTransactionError(code, message, cause === undefined ? undefined : { cause });
}

function aggregateCause(errors: unknown[]): unknown {
  return errors.length === 1 ? errors[0] : new AggregateError(errors);
}

async function syncDirectoryStrict(path: string): Promise<void> {
  const directory = await open(path, "r");
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}

async function fileMatchesHash(path: string, expectedHash: string): Promise<boolean> {
  try {
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink()) return false;
    return hashIOSFileBytes(await readFile(path)) === expectedHash;
  } catch {
    return false;
  }
}

async function readRegularFileIdentity(path: string): Promise<FileIdentity | undefined> {
  try {
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink()) return undefined;
    return { dev: info.dev, ino: info.ino, mode: info.mode & 0o7777 };
  } catch {
    return undefined;
  }
}

async function readRegularFileIdentityAndHash(
  path: string,
): Promise<{ identity: FileIdentity; hash: string } | undefined> {
  try {
    const beforeRead = await readRegularFileIdentity(path);
    if (!beforeRead) return undefined;
    const hash = hashIOSFileBytes(await readFile(path));
    const afterRead = await readRegularFileIdentity(path);
    if (!afterRead || !identitiesMatch(beforeRead, afterRead)) return undefined;
    return { identity: afterRead, hash };
  } catch {
    return undefined;
  }
}

async function readPathIdentity(path: string): Promise<FileIdentity | undefined> {
  try {
    const info = await lstat(path);
    return { dev: info.dev, ino: info.ino, mode: info.mode & 0o7777 };
  } catch {
    return undefined;
  }
}

async function readDirectoryIdentity(path: string): Promise<DirectoryIdentity | undefined> {
  try {
    const info = await lstat(path);
    if (!info.isDirectory() || info.isSymbolicLink()) return undefined;
    return { device: info.dev, inode: info.ino };
  } catch {
    return undefined;
  }
}

function identitiesMatch(left: FileIdentity, right: FileIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.mode === right.mode;
}

function sameFile(left: FileIdentity, right: FileIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function directoryIdentitiesMatch(left: DirectoryIdentity, right: DirectoryIdentity): boolean {
  return left.device === right.device && left.inode === right.inode;
}

function pathIsWithin(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

async function readCurrentMutationBoundary(
  rootPath: string,
  parentPath: string,
): Promise<Omit<IOSFileMutationBoundary, "rootPath"> | undefined> {
  try {
    const realRootPath = await realpath(rootPath);
    const realParentPath = await realpath(parentPath);
    if (!pathIsWithin(realRootPath, realParentPath)) return undefined;

    const rootIdentity = await readDirectoryIdentity(realRootPath);
    const parentIdentity = await readDirectoryIdentity(realParentPath);
    if (!rootIdentity || !parentIdentity) return undefined;

    const realRootAfterRead = await realpath(rootPath);
    const realParentAfterRead = await realpath(parentPath);
    const rootIdentityAfterRead = await readDirectoryIdentity(realRootAfterRead);
    const parentIdentityAfterRead = await readDirectoryIdentity(realParentAfterRead);
    if (
      realRootAfterRead !== realRootPath ||
      realParentAfterRead !== realParentPath ||
      !rootIdentityAfterRead ||
      !parentIdentityAfterRead ||
      !directoryIdentitiesMatch(rootIdentityAfterRead, rootIdentity) ||
      !directoryIdentitiesMatch(parentIdentityAfterRead, parentIdentity)
    ) {
      return undefined;
    }

    return { realRootPath, rootIdentity, realParentPath, parentIdentity };
  } catch {
    return undefined;
  }
}

/**
 * Captures the root and parent directory authorized for a prepared mutation.
 * Both paths are resolved twice around the identity reads so a moving or
 * replaced directory is rejected instead of being recorded inconsistently.
 *
 * @internal The returned evidence belongs only in hidden mutation state.
 */
export async function prepareIOSFileMutationBoundary(
  rootInput: string,
  mutationPathInput: string,
): Promise<IOSFileMutationBoundary | undefined> {
  const rootPath = resolve(rootInput);
  const mutationPath = resolve(mutationPathInput);
  if (!pathIsWithin(rootPath, mutationPath)) return undefined;

  const current = await readCurrentMutationBoundary(rootPath, dirname(mutationPath));
  return current ? { rootPath, ...current } : undefined;
}

async function mutationBoundaryStillMatches(mutation: IOSFileMutation): Promise<boolean> {
  const { boundary } = mutation;
  if (!pathIsWithin(boundary.rootPath, mutation.path)) return false;
  const current = await readCurrentMutationBoundary(boundary.rootPath, dirname(mutation.path));
  return (
    current !== undefined &&
    current.realRootPath === boundary.realRootPath &&
    current.realParentPath === boundary.realParentPath &&
    directoryIdentitiesMatch(current.rootIdentity, boundary.rootIdentity) &&
    directoryIdentitiesMatch(current.parentIdentity, boundary.parentIdentity)
  );
}

async function mutationBoundariesStillMatch(
  mutations: readonly IOSFileMutation[],
): Promise<boolean> {
  const matches = await Promise.all(
    mutations.map(async (mutation) => mutationBoundaryStillMatches(mutation)),
  );
  return matches.every(Boolean);
}

async function fileMatchesIdentityAndHash(
  path: string,
  expectedIdentity: FileIdentity,
  expectedHash: string,
): Promise<boolean> {
  try {
    const beforeRead = await readRegularFileIdentity(path);
    if (!beforeRead || !identitiesMatch(beforeRead, expectedIdentity)) return false;
    const matchesHash = hashIOSFileBytes(await readFile(path)) === expectedHash;
    const afterRead = await readRegularFileIdentity(path);
    return matchesHash && afterRead !== undefined && identitiesMatch(afterRead, expectedIdentity);
  } catch {
    return false;
  }
}

async function pathIsAbsent(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return false;
  } catch (error) {
    return isFileSystemError(error, "ENOENT");
  }
}

function isFileSystemError(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === code
  );
}

function transactionSiblingPath(
  path: string,
  purpose: string,
  transactionId?: string,
  index?: number,
): string {
  const owner =
    transactionId === undefined
      ? `${process.pid}-${randomUUID()}`
      : `${transactionId}-${index ?? 0}`;
  return resolve(dirname(path), `.${basename(path)}.clerk-${owner}.${purpose}`);
}

function transactionRoot(mutations: readonly IOSFileMutation[]): string {
  let rootPath = mutations[0]!.boundary.rootPath;
  while (mutations.some((mutation) => !pathIsWithin(rootPath, mutation.path))) {
    const parentPath = dirname(rootPath);
    if (parentPath === rootPath) {
      throw transactionError(
        "invalid-mutation",
        "The iOS file transaction did not have a usable shared recovery root.",
      );
    }
    rootPath = parentPath;
  }
  return rootPath;
}

async function stableRootLockKey(rootPath: string): Promise<RootLockKey | undefined> {
  const current = await readCurrentMutationBoundary(rootPath, rootPath);
  return current?.rootIdentity;
}

function transactionRecoveryDirectoryPath(
  destinationPath: string,
  transactionId: string,
  index: number,
): string {
  return resolve(
    dirname(destinationPath),
    `.${basename(destinationPath)}.clerk-${transactionId}-${index}.recovery`,
  );
}

function journalPath(rootPath: string, transactionId: string): string {
  return resolve(rootPath, `${JOURNAL_PREFIX}${transactionId}${JOURNAL_SUFFIX}`);
}

async function writeExclusiveSyncedFile(
  path: string,
  bytes: Uint8Array,
  mode: number,
  beforePublication?: (path: string, temporaryPath: string) => void | Promise<void>,
): Promise<FileIdentity> {
  const temporaryPath = transactionSiblingPath(path, "publication.tmp");
  let temporaryIdentity: FileIdentity | undefined;
  let published = false;
  try {
    const file = await open(temporaryPath, "wx", mode);
    try {
      await file.writeFile(bytes);
      await file.chmod(mode);
      await file.sync();
      const info = await file.stat();
      if (!info.isFile()) throw new Error("a publication source was not a regular file");
      temporaryIdentity = { dev: info.dev, ino: info.ino, mode: info.mode & 0o7777 };
    } finally {
      await file.close();
    }
    await beforePublication?.(path, temporaryPath);
    await link(temporaryPath, path);
    published = true;
    const publishedIdentity = await readRegularFileIdentity(path);
    const temporaryIdentityAfterLink = await readRegularFileIdentity(temporaryPath);
    if (
      !temporaryIdentity ||
      !publishedIdentity ||
      !temporaryIdentityAfterLink ||
      !identitiesMatch(temporaryIdentity, publishedIdentity) ||
      !identitiesMatch(temporaryIdentity, temporaryIdentityAfterLink)
    ) {
      throw new IOSFileTransactionOwnershipError(
        "an atomically published transaction file could not be identified",
      );
    }
    await syncDirectoryStrict(dirname(path));
  } catch (error) {
    const cleanupErrors: unknown[] = [];
    if (published && temporaryIdentity) {
      try {
        const publishedIdentity = await readRegularFileIdentity(path);
        if (publishedIdentity && sameFile(publishedIdentity, temporaryIdentity)) {
          await rm(path);
          await syncDirectoryStrict(dirname(path));
        }
      } catch (cleanupError) {
        cleanupErrors.push(cleanupError);
      }
    }
    if (temporaryIdentity) {
      try {
        const currentIdentity = await readRegularFileIdentity(temporaryPath);
        if (currentIdentity && sameFile(currentIdentity, temporaryIdentity)) {
          await rm(temporaryPath);
          await syncDirectoryStrict(dirname(temporaryPath));
        }
      } catch (cleanupError) {
        cleanupErrors.push(cleanupError);
      }
    }
    throw cleanupErrors.length > 0 ? aggregateCause([error, ...cleanupErrors]) : error;
  }
  try {
    await rm(temporaryPath);
    await syncDirectoryStrict(dirname(temporaryPath));
  } catch {
    // Publication is already complete and directory-synced. A retained source
    // hard link is harmless and must not poison a live lock or journal.
  }
  if (!temporaryIdentity) {
    throw new IOSFileTransactionOwnershipError(
      "an atomically published transaction file did not retain its identity",
    );
  }
  return temporaryIdentity;
}

interface RootLockLease {
  path: string;
  identity: FileIdentity;
  hash: string;
  directoryPath: string;
}

type RootLockKey = DirectoryIdentity;

function rootLockKeyName(key: RootLockKey): string {
  return `${key.device}-${key.inode}`;
}

async function rootLockDirectory(): Promise<string> {
  const path = resolve(tmpdir(), ROOT_LOCK_DIRECTORY_NAME);
  let created = false;
  try {
    await mkdir(path, { mode: 0o700 });
    created = true;
  } catch (error) {
    if (!isFileSystemError(error, "EEXIST")) throw error;
  }
  const info = await lstat(path);
  const expectedUserId = typeof process.getuid === "function" ? process.getuid() : undefined;
  if (
    !info.isDirectory() ||
    info.isSymbolicLink() ||
    (info.mode & 0o077) !== 0 ||
    (expectedUserId !== undefined && info.uid !== expectedUserId)
  ) {
    throw new IOSFileTransactionOwnershipError(
      "the private iOS transaction lock directory was not safely owned",
    );
  }
  if (created) await syncDirectoryStrict(dirname(path));
  return path;
}

async function readRootLock(
  path: string,
  expectedKey: RootLockKey,
): Promise<{ processId: number; identity: FileIdentity; hash: string }> {
  const beforeRead = await readRegularFileIdentity(path);
  if (!beforeRead) throw new Error("invalid iOS file transaction lock");
  const contents = await readFile(path, "utf8");
  if (Buffer.byteLength(contents) > 4_096) throw new Error("oversized iOS file transaction lock");
  const afterRead = await readRegularFileIdentity(path);
  if (!afterRead || !identitiesMatch(beforeRead, afterRead)) {
    throw new Error("the iOS file transaction lock changed while it was read");
  }
  const value: unknown = JSON.parse(contents);
  if (
    !isRecord(value) ||
    value.schemaVersion !== 1 ||
    value.kind !== "clerk-ios-file-transaction-lock" ||
    !Number.isSafeInteger(value.processId) ||
    (value.processId as number) <= 0 ||
    value.rootDevice !== expectedKey.device ||
    value.rootInode !== expectedKey.inode ||
    typeof value.token !== "string" ||
    !/^[0-9a-f-]{36}$/i.test(value.token)
  ) {
    throw new Error("invalid iOS file transaction lock contents");
  }
  return {
    processId: value.processId as number,
    identity: afterRead,
    hash: hashIOSFileBytes(contents),
  };
}

async function acquireRootLock(
  key: RootLockKey,
  beforePublication?: (path: string, temporaryPath: string) => void | Promise<void>,
): Promise<RootLockLease> {
  const directoryPath = await rootLockDirectory();
  const path = resolve(directoryPath, `root-${rootLockKeyName(key)}.lock`);
  for (;;) {
    const contents = `${JSON.stringify({
      schemaVersion: 1,
      kind: "clerk-ios-file-transaction-lock",
      processId: process.pid,
      rootDevice: key.device,
      rootInode: key.inode,
      token: randomUUID(),
    })}\n`;
    try {
      await writeExclusiveSyncedFile(
        path,
        new TextEncoder().encode(contents),
        0o600,
        beforePublication,
      );
      const identity = await readRegularFileIdentity(path);
      if (!identity) throw new Error("the iOS file transaction lock could not be identified");
      return { path, identity, hash: hashIOSFileBytes(contents), directoryPath };
    } catch (error) {
      if (!isFileSystemError(error, "EEXIST")) throw error;
    }

    const lock = await readRootLock(path, key);
    if (processIsAlive(lock.processId)) {
      // A recycled PID may conservatively block recovery, but never permits
      // this process to steal a lock that could belong to a live transaction.
      throw new IOSFileTransactionOwnershipError(
        "another process still owns the iOS file transaction lock",
      );
    }
    const claimPath = transactionSiblingPath(path, "stale.claimed");
    const claim = await claimDestination(path, lock.identity, lock.hash, claimPath);
    if (claim.status === "stale") continue;
    await removeClaimedPath(claim.claim, {
      expectedHash: lock.hash,
      expectedMode: lock.identity.mode,
    });
    await syncDirectoryStrict(directoryPath);
  }
}

async function releaseRootLock(lock: RootLockLease): Promise<void> {
  await removeClaimedPath(
    { path: lock.path, present: true, identity: lock.identity },
    { expectedHash: lock.hash, expectedMode: lock.identity.mode },
  );
  await syncDirectoryStrict(lock.directoryPath);
}

async function withRootLock<T>(
  key: RootLockKey,
  operation: () => Promise<T>,
  beforePublication?: (path: string, temporaryPath: string) => void | Promise<void>,
): Promise<T> {
  const keyName = rootLockKeyName(key);
  const heldRoots = rootLockContext.getStore();
  if (heldRoots?.has(keyName)) return operation();

  let lock: RootLockLease;
  try {
    lock = await acquireRootLock(key, beforePublication);
  } catch (error) {
    throw transactionError(
      "recovery-failed",
      "The iOS file transaction recovery lock could not be acquired.",
      error,
    );
  }
  const nestedRoots = new Set(heldRoots);
  nestedRoots.add(keyName);
  try {
    return await rootLockContext.run(nestedRoots, operation);
  } finally {
    await releaseRootLock(lock);
  }
}

function journalBytes(record: IOSFileTransactionJournalRecord): Uint8Array {
  const bytes = new TextEncoder().encode(`${JSON.stringify(record)}\n`);
  if (bytes.byteLength > MAX_JOURNAL_BYTES) {
    throw new Error("the iOS file transaction recovery journal was too large");
  }
  return bytes;
}

async function removeRecoveryDirectory(
  path: string,
  expectedIdentity: DirectoryIdentity,
): Promise<void> {
  let info;
  try {
    info = await lstat(path);
  } catch (error) {
    if (isFileSystemError(error, "ENOENT")) return;
    throw error;
  }
  if (
    !info.isDirectory() ||
    info.isSymbolicLink() ||
    info.dev !== expectedIdentity.device ||
    info.ino !== expectedIdentity.inode
  ) {
    throw new IOSFileTransactionOwnershipError(
      "an iOS recovery directory no longer identified the transaction's directory",
    );
  }
  await rmdir(path);
  await syncDirectoryStrict(dirname(path));
}

async function removeStagedRecoveryDirectories(staged: readonly StagedMutation[]): Promise<void> {
  const errors: unknown[] = [];
  for (const item of [...staged].reverse()) {
    if (!item.recoveryDirectory?.present) continue;
    try {
      await removeRecoveryDirectory(item.recoveryDirectory.path, item.recoveryDirectory.identity);
      item.recoveryDirectory.present = false;
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length > 0) throw aggregateCause(errors);
}

async function removeJournalRecoveryDirectories(
  record: IOSFileTransactionJournalRecord,
): Promise<void> {
  for (const mutation of [...record.mutations].reverse()) {
    await removeRecoveryDirectory(
      mutation.recoveryDirectoryPath,
      mutation.recoveryDirectoryIdentity,
    );
  }
}

async function cleanupInitialJournalSetupIfAuthorized(
  journal: IOSFileTransactionJournal,
  staged: readonly StagedMutation[],
): Promise<boolean> {
  const mutations = staged.map((item) => item.mutation);
  if (!(await mutationBoundariesStillMatch(mutations))) return false;

  if (journal.present) {
    if (
      !journal.identity ||
      !journal.hash ||
      !(await fileMatchesIdentityAndHash(journal.path, journal.identity, journal.hash)) ||
      !(await mutationBoundariesStillMatch(mutations))
    ) {
      return false;
    }
    await rm(journal.path);
    journal.present = false;
    if (!(await mutationBoundariesStillMatch(mutations))) return false;
    await syncDirectoryStrict(journal.record.rootPath);
  }

  if (!(await mutationBoundariesStillMatch(mutations))) return false;
  await removeStagedRecoveryDirectories(staged);
  return mutationBoundariesStillMatch(mutations);
}

async function createTransactionJournal(
  staged: readonly StagedMutation[],
  beforePublication?: (path: string, temporaryPath: string) => void | Promise<void>,
  afterPublication?: (journalPath: string) => void | Promise<void>,
): Promise<IOSFileTransactionJournal> {
  const rootPath = transactionRoot(staged.map((item) => item.mutation));
  const transactionId = randomUUID();
  try {
    for (const [index, item] of staged.entries()) {
      if (!(await mutationBoundaryStillMatches(item.mutation))) {
        throw new IOSFileTransactionStaleError();
      }
      const recoveryDirectoryPath = transactionRecoveryDirectoryPath(
        item.mutation.path,
        transactionId,
        index,
      );
      await mkdir(recoveryDirectoryPath, { mode: 0o700 });
      const recoveryDirectoryIdentity = await readDirectoryIdentity(recoveryDirectoryPath);
      if (!recoveryDirectoryIdentity) {
        throw new Error("an iOS recovery directory could not be identified");
      }
      item.recoveryDirectory = {
        path: recoveryDirectoryPath,
        present: true,
        identity: recoveryDirectoryIdentity,
      };
      if (!(await mutationBoundaryStillMatches(item.mutation))) {
        await removeStagedRecoveryDirectories(staged);
        throw new IOSFileTransactionStaleError();
      }
      item.rollbackClaimPath = resolve(recoveryDirectoryPath, "candidate");
      if (!isCreateMutation(item.mutation)) {
        item.originalClaimPath = resolve(recoveryDirectoryPath, "original");
      }
      await syncDirectoryStrict(recoveryDirectoryPath);
      await syncDirectoryStrict(dirname(recoveryDirectoryPath));
    }
  } catch (error) {
    await removeStagedRecoveryDirectories(staged);
    throw error;
  }
  const record: IOSFileTransactionJournalRecord = {
    schemaVersion: 1,
    kind: "clerk-ios-file-transaction",
    transactionId,
    processId: process.pid,
    rootPath,
    state: "pending",
    mutations: staged.map((item) => ({
      kind: isCreateMutation(item.mutation) ? "create" : "existing",
      destinationPath: item.mutation.path,
      temporaryPath: item.temporaryPath,
      originalClaimPath: item.originalClaimPath,
      rollbackClaimPath: item.rollbackClaimPath!,
      originalHash: isCreateMutation(item.mutation) ? undefined : item.mutation.originalHash,
      candidateHash: item.mutation.candidateHash,
      mode: item.mutation.mode,
      recoveryDirectoryPath: item.recoveryDirectory!.path,
      recoveryDirectoryIdentity: { ...item.recoveryDirectory!.identity },
      boundary: {
        rootPath: item.mutation.boundary.rootPath,
        realRootPath: item.mutation.boundary.realRootPath,
        rootIdentity: { ...item.mutation.boundary.rootIdentity },
        realParentPath: item.mutation.boundary.realParentPath,
        parentIdentity: { ...item.mutation.boundary.parentIdentity },
      },
    })),
  };
  const path = journalPath(rootPath, transactionId);
  const bytes = journalBytes(record);
  const journal: IOSFileTransactionJournal = {
    path,
    nextPath: `${path}.next`,
    record,
    present: false,
    hash: hashIOSFileBytes(bytes),
  };

  try {
    const stagedDirectories = new Set(staged.map((item) => dirname(item.temporaryPath)));
    for (const directory of stagedDirectories) await syncDirectoryStrict(directory);
    if (!(await mutationBoundariesStillMatch(staged.map((item) => item.mutation)))) {
      throw new IOSFileTransactionStaleError();
    }
    journal.identity = await writeExclusiveSyncedFile(path, bytes, 0o600, async (...args) => {
      await beforePublication?.(...args);
      if (!(await mutationBoundariesStillMatch(staged.map((item) => item.mutation)))) {
        throw new IOSFileTransactionStaleError();
      }
    });
    journal.present = true;
    await afterPublication?.(path);
    if (!(await mutationBoundariesStillMatch(staged.map((item) => item.mutation)))) {
      throw new IOSFileTransactionStaleError();
    }
    activeJournalPaths.add(path);
    return journal;
  } catch (error) {
    let cleanupIsSafe: boolean;
    try {
      cleanupIsSafe = await cleanupInitialJournalSetupIfAuthorized(journal, staged);
    } catch (cleanupError) {
      if (await mutationBoundariesStillMatch(staged.map((item) => item.mutation))) {
        throw aggregateCause([error, cleanupError]);
      }
      throw new IOSFileTransactionUnsafeSetupCleanupError(aggregateCause([error, cleanupError]));
    }
    if (cleanupIsSafe) throw error;
    // The lexical root or a destination parent no longer identifies the
    // authorized directories. Keep a published no-op journal and its staged
    // artifacts intact so a later invocation can recover them after the
    // original boundary is restored.
    throw new IOSFileTransactionUnsafeSetupCleanupError(error);
  }
}

async function markTransactionCommitted(journal: IOSFileTransactionJournal): Promise<void> {
  const committed: IOSFileTransactionJournalRecord = {
    ...journal.record,
    state: "committed",
  };
  try {
    await rm(journal.nextPath, { force: true });
    await writeExclusiveSyncedFile(journal.nextPath, journalBytes(committed), 0o600);
    await rename(journal.nextPath, journal.path);
    journal.record = committed;
    await syncDirectoryStrict(committed.rootPath);
  } catch (error) {
    try {
      await rm(journal.nextPath, { force: true });
    } catch {
      // A pending journal remains authoritative until the atomic rename.
    }
    throw error;
  }
}

async function removeTransactionJournal(journal: IOSFileTransactionJournal): Promise<void> {
  try {
    await removeJournalRecoveryDirectories(journal.record);
    await rm(journal.nextPath, { force: true });
    if (journal.present) {
      await rm(journal.path);
      journal.present = false;
    }
    await syncDirectoryStrict(journal.record.rootPath);
  } finally {
    activeJournalPaths.delete(journal.path);
  }
}

type RecoveryFileState =
  | { kind: "absent" }
  | { kind: "file"; identity: FileIdentity; hash: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSHA256(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{64}$/i.test(value);
}

function isExpectedTemporaryPath(path: string, destinationPath: string): boolean {
  const name = basename(path);
  return (
    dirname(path) === dirname(destinationPath) &&
    name.startsWith(`.${basename(destinationPath)}.clerk-`) &&
    name.endsWith(".tmp")
  );
}

function parseRecoveryBoundary(
  value: unknown,
  transactionRootPath: string,
  destinationPath: string,
): IOSFileMutationBoundary {
  if (
    !isRecord(value) ||
    typeof value.rootPath !== "string" ||
    typeof value.realRootPath !== "string" ||
    typeof value.realParentPath !== "string" ||
    !isRecord(value.rootIdentity) ||
    !Number.isSafeInteger(value.rootIdentity.device) ||
    (value.rootIdentity.device as number) < 0 ||
    !Number.isSafeInteger(value.rootIdentity.inode) ||
    (value.rootIdentity.inode as number) < 0 ||
    !isRecord(value.parentIdentity) ||
    !Number.isSafeInteger(value.parentIdentity.device) ||
    (value.parentIdentity.device as number) < 0 ||
    !Number.isSafeInteger(value.parentIdentity.inode) ||
    (value.parentIdentity.inode as number) < 0
  ) {
    throw new Error("invalid iOS file transaction recovery boundary");
  }
  const boundary: IOSFileMutationBoundary = {
    rootPath: resolve(value.rootPath),
    realRootPath: resolve(value.realRootPath),
    rootIdentity: {
      device: value.rootIdentity.device as number,
      inode: value.rootIdentity.inode as number,
    },
    realParentPath: resolve(value.realParentPath),
    parentIdentity: {
      device: value.parentIdentity.device as number,
      inode: value.parentIdentity.inode as number,
    },
  };
  if (
    boundary.rootPath !== value.rootPath ||
    boundary.realRootPath !== value.realRootPath ||
    boundary.realParentPath !== value.realParentPath ||
    !pathIsWithin(transactionRootPath, boundary.rootPath) ||
    !pathIsWithin(boundary.rootPath, destinationPath) ||
    !pathIsWithin(boundary.realRootPath, boundary.realParentPath)
  ) {
    throw new Error("unsafe iOS file transaction recovery boundary");
  }
  return boundary;
}

function parseTransactionJournal(
  value: unknown,
  rootPath: string,
  transactionId: string,
): IOSFileTransactionJournalRecord {
  if (
    !isRecord(value) ||
    value.schemaVersion !== 1 ||
    value.kind !== "clerk-ios-file-transaction" ||
    value.transactionId !== transactionId ||
    value.rootPath !== rootPath ||
    (value.state !== "pending" && value.state !== "committed") ||
    !Number.isSafeInteger(value.processId) ||
    (value.processId as number) <= 0 ||
    !Array.isArray(value.mutations) ||
    value.mutations.length === 0
  ) {
    throw new Error("invalid iOS file transaction recovery journal");
  }

  const paths = new Set<string>();
  const mutations: IOSFileTransactionJournalMutation[] = value.mutations.map((candidate, index) => {
    if (
      !isRecord(candidate) ||
      (candidate.kind !== "create" && candidate.kind !== "existing") ||
      typeof candidate.destinationPath !== "string" ||
      typeof candidate.temporaryPath !== "string" ||
      typeof candidate.rollbackClaimPath !== "string" ||
      typeof candidate.recoveryDirectoryPath !== "string" ||
      !isRecord(candidate.recoveryDirectoryIdentity) ||
      !Number.isSafeInteger(candidate.recoveryDirectoryIdentity.device) ||
      (candidate.recoveryDirectoryIdentity.device as number) < 0 ||
      !Number.isSafeInteger(candidate.recoveryDirectoryIdentity.inode) ||
      (candidate.recoveryDirectoryIdentity.inode as number) < 0 ||
      !isSHA256(candidate.candidateHash) ||
      !Number.isInteger(candidate.mode) ||
      (candidate.mode as number) < 0 ||
      (candidate.mode as number) > 0o7777
    ) {
      throw new Error("invalid iOS file transaction recovery mutation");
    }
    const destinationPath = resolve(candidate.destinationPath);
    const temporaryPath = resolve(candidate.temporaryPath);
    const rollbackClaimPath = resolve(candidate.rollbackClaimPath);
    const recoveryDirectoryPath = resolve(candidate.recoveryDirectoryPath);
    const originalClaimPath =
      typeof candidate.originalClaimPath === "string"
        ? resolve(candidate.originalClaimPath)
        : undefined;
    const boundary = parseRecoveryBoundary(candidate.boundary, rootPath, destinationPath);
    if (
      destinationPath !== candidate.destinationPath ||
      temporaryPath !== candidate.temporaryPath ||
      rollbackClaimPath !== candidate.rollbackClaimPath ||
      recoveryDirectoryPath !== candidate.recoveryDirectoryPath ||
      !pathIsWithin(rootPath, destinationPath) ||
      destinationPath === rootPath ||
      !isExpectedTemporaryPath(temporaryPath, destinationPath) ||
      recoveryDirectoryPath !==
        transactionRecoveryDirectoryPath(destinationPath, transactionId, index) ||
      rollbackClaimPath !== resolve(recoveryDirectoryPath, "candidate") ||
      (candidate.kind === "existing" &&
        (originalClaimPath === undefined ||
          originalClaimPath !== resolve(recoveryDirectoryPath, "original"))) ||
      (candidate.kind === "create" && originalClaimPath !== undefined) ||
      (candidate.kind === "existing" && !isSHA256(candidate.originalHash)) ||
      (candidate.kind === "create" && candidate.originalHash !== undefined)
    ) {
      throw new Error("unsafe iOS file transaction recovery path");
    }
    for (const path of [
      destinationPath,
      temporaryPath,
      recoveryDirectoryPath,
      rollbackClaimPath,
      ...(originalClaimPath ? [originalClaimPath] : []),
    ]) {
      if (paths.has(path)) throw new Error("duplicate iOS file transaction recovery path");
      paths.add(path);
    }
    return {
      kind: candidate.kind,
      destinationPath,
      temporaryPath,
      originalClaimPath,
      rollbackClaimPath,
      originalHash: candidate.kind === "existing" ? (candidate.originalHash as string) : undefined,
      candidateHash: candidate.candidateHash,
      mode: candidate.mode as number,
      boundary,
      recoveryDirectoryPath,
      recoveryDirectoryIdentity: {
        device: candidate.recoveryDirectoryIdentity.device as number,
        inode: candidate.recoveryDirectoryIdentity.inode as number,
      },
    };
  });

  return {
    schemaVersion: 1,
    kind: "clerk-ios-file-transaction",
    transactionId,
    processId: value.processId as number,
    rootPath,
    state: value.state,
    mutations,
  };
}

async function readTransactionJournal(
  path: string,
  rootPath: string,
  transactionId: string,
): Promise<IOSFileTransactionJournalRecord> {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_JOURNAL_BYTES) {
    throw new Error("invalid iOS file transaction recovery journal file");
  }
  const contents = await readFile(path, "utf8");
  if (Buffer.byteLength(contents) > MAX_JOURNAL_BYTES) {
    throw new Error("oversized iOS file transaction recovery journal");
  }
  return parseTransactionJournal(JSON.parse(contents), rootPath, transactionId);
}

async function recoveryBoundaryStillMatches(
  mutation: IOSFileTransactionJournalMutation,
): Promise<boolean> {
  const { boundary } = mutation;
  const current = await readCurrentMutationBoundary(
    boundary.rootPath,
    dirname(mutation.destinationPath),
  );
  return (
    current !== undefined &&
    current.realRootPath === boundary.realRootPath &&
    current.realParentPath === boundary.realParentPath &&
    directoryIdentitiesMatch(current.rootIdentity, boundary.rootIdentity) &&
    directoryIdentitiesMatch(current.parentIdentity, boundary.parentIdentity)
  );
}

async function assertRecoveryBoundary(mutation: IOSFileTransactionJournalMutation): Promise<void> {
  if (!(await recoveryBoundaryStillMatches(mutation))) {
    throw new IOSFileTransactionOwnershipError(
      "an interrupted iOS mutation boundary no longer matched its prepared directory",
    );
  }
  try {
    const info = await lstat(mutation.recoveryDirectoryPath);
    if (
      !info.isDirectory() ||
      info.isSymbolicLink() ||
      info.dev !== mutation.recoveryDirectoryIdentity.device ||
      info.ino !== mutation.recoveryDirectoryIdentity.inode
    ) {
      throw new IOSFileTransactionOwnershipError(
        "an interrupted iOS recovery directory no longer matched its prepared identity",
      );
    }
  } catch (error) {
    if (!isFileSystemError(error, "ENOENT")) throw error;
  }
}

async function readRecoveryFile(
  path: string,
  mutation?: IOSFileTransactionJournalMutation,
): Promise<RecoveryFileState> {
  if (mutation) await assertRecoveryBoundary(mutation);
  let info;
  try {
    info = await lstat(path);
  } catch (error) {
    if (isFileSystemError(error, "ENOENT")) return { kind: "absent" };
    throw error;
  }
  if (!info.isFile() || info.isSymbolicLink()) {
    throw new IOSFileTransactionOwnershipError(
      "a recovery path no longer identified a regular file",
    );
  }
  const value = await readRegularFileIdentityAndHash(path);
  if (!value) {
    throw new IOSFileTransactionOwnershipError(
      "a recovery file changed while it was being identified",
    );
  }
  return { kind: "file", ...value };
}

function recoveryFileMatches(
  state: RecoveryFileState,
  hash: string,
  mode: number,
): state is Extract<RecoveryFileState, { kind: "file" }> {
  return state.kind === "file" && state.hash === hash && state.identity.mode === mode;
}

function recoveryFileMatchesCandidate(
  state: RecoveryFileState,
  temporary: RecoveryFileState,
  mutation: IOSFileTransactionJournalMutation,
): state is Extract<RecoveryFileState, { kind: "file" }> {
  return (
    recoveryFileMatches(state, mutation.candidateHash, mutation.mode) &&
    recoveryFileMatches(temporary, mutation.candidateHash, mutation.mode) &&
    sameFile(state.identity, temporary.identity)
  );
}

async function removeRecoveryFile(
  path: string,
  hash: string,
  mode: number,
  mutation: IOSFileTransactionJournalMutation,
): Promise<void> {
  const state = await readRecoveryFile(path, mutation);
  if (state.kind === "absent") return;
  if (!recoveryFileMatches(state, hash, mode)) {
    throw new IOSFileTransactionOwnershipError(
      "a recovery artifact no longer contained the transaction's file",
    );
  }
  await assertRecoveryBoundary(mutation);
  await removeClaimedPath(
    { path, present: true, identity: state.identity },
    {
      expectedHash: hash,
      expectedMode: mode,
    },
  );
  await syncDirectoryStrict(dirname(path));
}

async function restoreRecoveryFile(
  path: string,
  destinationPath: string,
  mutation: IOSFileTransactionJournalMutation,
): Promise<void> {
  const state = await readRecoveryFile(path, mutation);
  if (state.kind === "absent") {
    throw new IOSFileTransactionOwnershipError("a required recovery file was missing");
  }
  await assertRecoveryBoundary(mutation);
  await restoreClaimWithoutClobber(
    { path, present: true, identity: state.identity },
    destinationPath,
  );
}

async function claimRecoveryDestination(
  destinationPath: string,
  state: Extract<RecoveryFileState, { kind: "file" }>,
  hash: string,
  claimPath: string,
  mutation: IOSFileTransactionJournalMutation,
): Promise<void> {
  if ((await readRecoveryFile(claimPath, mutation)).kind !== "absent") {
    throw new IOSFileTransactionOwnershipError("a recovery claim path was already occupied");
  }
  await assertRecoveryBoundary(mutation);
  const result = await claimDestination(
    destinationPath,
    state.identity,
    hash,
    claimPath,
    mutation.recoveryDirectoryIdentity,
  );
  if (result.status === "stale") {
    throw new IOSFileTransactionOwnershipError(
      "a destination changed while interrupted work was being recovered",
    );
  }
}

async function recoverPendingExisting(mutation: IOSFileTransactionJournalMutation): Promise<void> {
  const originalHash = mutation.originalHash!;
  let destination = await readRecoveryFile(mutation.destinationPath, mutation);
  let original = await readRecoveryFile(mutation.originalClaimPath!, mutation);
  let rollback = await readRecoveryFile(mutation.rollbackClaimPath, mutation);
  const temporary = await readRecoveryFile(mutation.temporaryPath, mutation);

  if (destination.kind === "absent") {
    if (rollback.kind === "file") {
      if (recoveryFileMatchesCandidate(rollback, temporary, mutation) && original.kind === "file") {
        await restoreRecoveryFile(mutation.originalClaimPath!, mutation.destinationPath, mutation);
      } else {
        await restoreRecoveryFile(mutation.rollbackClaimPath, mutation.destinationPath, mutation);
      }
    } else if (original.kind === "file") {
      await restoreRecoveryFile(mutation.originalClaimPath!, mutation.destinationPath, mutation);
    } else {
      throw new IOSFileTransactionOwnershipError(
        "an interrupted replacement had no file that could restore its destination",
      );
    }
    destination = await readRecoveryFile(mutation.destinationPath, mutation);
    original = await readRecoveryFile(mutation.originalClaimPath!, mutation);
    rollback = await readRecoveryFile(mutation.rollbackClaimPath, mutation);
  }

  if (recoveryFileMatchesCandidate(destination, temporary, mutation)) {
    if (original.kind !== "file") {
      throw new IOSFileTransactionOwnershipError(
        "an interrupted replacement no longer had its original file",
      );
    }
    if (rollback.kind === "file") {
      await removeRecoveryFile(
        mutation.rollbackClaimPath,
        mutation.candidateHash,
        mutation.mode,
        mutation,
      );
    }
    await claimRecoveryDestination(
      mutation.destinationPath,
      destination,
      mutation.candidateHash,
      mutation.rollbackClaimPath,
      mutation,
    );
    await restoreRecoveryFile(mutation.originalClaimPath!, mutation.destinationPath, mutation);
    destination = await readRecoveryFile(mutation.destinationPath, mutation);
  }

  if (destination.kind === "absent") {
    throw new IOSFileTransactionOwnershipError(
      "an interrupted replacement still had no public destination after recovery",
    );
  }

  original = await readRecoveryFile(mutation.originalClaimPath!, mutation);
  if (original.kind === "file") {
    const restoredOriginal =
      destination.kind === "file" && sameFile(destination.identity, original.identity);
    await removeRecoveryFile(
      mutation.originalClaimPath!,
      restoredOriginal ? original.hash : originalHash,
      restoredOriginal ? original.identity.mode : mutation.mode,
      mutation,
    );
  }
  rollback = await readRecoveryFile(mutation.rollbackClaimPath, mutation);
  if (rollback.kind === "file") {
    await removeRecoveryFile(
      mutation.rollbackClaimPath,
      mutation.candidateHash,
      mutation.mode,
      mutation,
    );
  }
  await removeRecoveryFile(mutation.temporaryPath, mutation.candidateHash, mutation.mode, mutation);
}

async function recoverPendingCreate(mutation: IOSFileTransactionJournalMutation): Promise<void> {
  let destination = await readRecoveryFile(mutation.destinationPath, mutation);
  let rollback = await readRecoveryFile(mutation.rollbackClaimPath, mutation);
  const temporary = await readRecoveryFile(mutation.temporaryPath, mutation);

  if (destination.kind === "absent" && rollback.kind === "file") {
    if (recoveryFileMatchesCandidate(rollback, temporary, mutation)) {
      await removeRecoveryFile(
        mutation.rollbackClaimPath,
        mutation.candidateHash,
        mutation.mode,
        mutation,
      );
    } else {
      await restoreRecoveryFile(mutation.rollbackClaimPath, mutation.destinationPath, mutation);
    }
    destination = await readRecoveryFile(mutation.destinationPath, mutation);
    rollback = await readRecoveryFile(mutation.rollbackClaimPath, mutation);
  }

  if (recoveryFileMatchesCandidate(destination, temporary, mutation)) {
    if (rollback.kind === "file") {
      await removeRecoveryFile(
        mutation.rollbackClaimPath,
        mutation.candidateHash,
        mutation.mode,
        mutation,
      );
    }
    await claimRecoveryDestination(
      mutation.destinationPath,
      destination,
      mutation.candidateHash,
      mutation.rollbackClaimPath,
      mutation,
    );
    await removeRecoveryFile(
      mutation.rollbackClaimPath,
      mutation.candidateHash,
      mutation.mode,
      mutation,
    );
  }

  rollback = await readRecoveryFile(mutation.rollbackClaimPath, mutation);
  if (rollback.kind === "file") {
    throw new IOSFileTransactionOwnershipError(
      "an interrupted create left an unrecognized recovery claim",
    );
  }
  await removeRecoveryFile(mutation.temporaryPath, mutation.candidateHash, mutation.mode, mutation);
}

async function recoverCommittedMutation(
  mutation: IOSFileTransactionJournalMutation,
): Promise<void> {
  const destination = await readRecoveryFile(mutation.destinationPath, mutation);
  if (destination.kind === "absent") {
    const temporary = await readRecoveryFile(mutation.temporaryPath, mutation);
    const rollback = await readRecoveryFile(mutation.rollbackClaimPath, mutation);
    const sourcePath = recoveryFileMatches(temporary, mutation.candidateHash, mutation.mode)
      ? mutation.temporaryPath
      : recoveryFileMatches(rollback, mutation.candidateHash, mutation.mode)
        ? mutation.rollbackClaimPath
        : undefined;
    const source = sourcePath
      ? await readRecoveryFile(sourcePath, mutation)
      : { kind: "absent" as const };
    if (!sourcePath || source.kind !== "file") {
      throw new IOSFileTransactionOwnershipError(
        "a committed replacement had no candidate that could restore its destination",
      );
    }
    await assertRecoveryBoundary(mutation);
    const installResult = await linkOwnedSourceWithoutClobber(
      sourcePath,
      source.identity,
      mutation.candidateHash,
      mutation.destinationPath,
    );
    if (installResult === "linked") await syncDirectoryStrict(dirname(mutation.destinationPath));
  }

  if (mutation.originalClaimPath && mutation.originalHash) {
    await removeRecoveryFile(
      mutation.originalClaimPath,
      mutation.originalHash,
      mutation.mode,
      mutation,
    );
  }
  await removeRecoveryFile(
    mutation.rollbackClaimPath,
    mutation.candidateHash,
    mutation.mode,
    mutation,
  );
  await removeRecoveryFile(mutation.temporaryPath, mutation.candidateHash, mutation.mode, mutation);
}

function processIsAlive(processId: number): boolean {
  try {
    process.kill(processId, 0);
    return true;
  } catch (error) {
    return !isFileSystemError(error, "ESRCH");
  }
}

async function recoverTransactionJournal(journal: IOSFileTransactionJournal): Promise<void> {
  const mutations =
    journal.record.state === "pending"
      ? [...journal.record.mutations].reverse()
      : journal.record.mutations;
  for (const mutation of mutations) {
    if (journal.record.state === "committed") {
      await recoverCommittedMutation(mutation);
    } else if (mutation.kind === "create") {
      await recoverPendingCreate(mutation);
    } else {
      await recoverPendingExisting(mutation);
    }
  }
  const directories = new Set(mutations.map((mutation) => dirname(mutation.destinationPath)));
  for (const directory of directories) await syncDirectoryStrict(directory);
  await removeTransactionJournal(journal);
}

async function recoverIOSFileTransactionsUnlocked(rootPath: string): Promise<void> {
  let entries;
  try {
    entries = await readdir(rootPath, { withFileTypes: true });
  } catch (error) {
    if (isFileSystemError(error, "ENOENT")) return;
    throw error;
  }
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const match = JOURNAL_NAME_PATTERN.exec(entry.name);
    if (!match) continue;
    const path = resolve(rootPath, entry.name);
    if (activeJournalPaths.has(path)) continue;
    try {
      const record = await readTransactionJournal(path, rootPath, match[1]!);
      if (processIsAlive(record.processId)) {
        throw new IOSFileTransactionOwnershipError(
          "another process still owns an iOS file transaction recovery journal",
        );
      }
      const journal: IOSFileTransactionJournal = {
        path,
        nextPath: `${path}.next`,
        record,
        present: true,
      };
      activeJournalPaths.add(path);
      try {
        await recoverTransactionJournal(journal);
      } finally {
        activeJournalPaths.delete(path);
      }
    } catch (error) {
      throw transactionError(
        "recovery-failed",
        "An interrupted iOS file transaction could not be recovered automatically.",
        error,
      );
    }
  }
}

/**
 * Reports whether a durable iOS file transaction still needs recovery.
 *
 * This check is intentionally read-only. Doctor, dry-run, and other
 * inspection-only callers use it to fail closed without changing the
 * checkout. A mutating `clerk init` path must call
 * {@link recoverIOSFileTransactions} before it performs semantic inspection.
 */
export async function hasInterruptedIOSFileTransaction(rootInput: string): Promise<boolean> {
  const rootPath = resolve(rootInput);
  try {
    const entries = await readdir(rootPath, { withFileTypes: true });
    return entries.some(
      (entry) =>
        JOURNAL_NAME_PATTERN.test(entry.name) &&
        !activeJournalPaths.has(resolve(rootPath, entry.name)),
    );
  } catch (error) {
    if (isFileSystemError(error, "ENOENT")) return false;
    throw error;
  }
}

/** Recovers durable file transactions left by an interrupted CLI process. */
export async function recoverIOSFileTransactions(rootInput: string): Promise<void> {
  const rootPath = resolve(rootInput);
  const existing = recoveryByRoot.get(rootPath);
  if (existing) return existing;
  // Ordinary inspection, Doctor, and dry-run calls remain genuinely
  // read-only. A root lock is needed only when a durable journal proves that
  // interrupted work must be serialized and recovered.
  if (!(await hasInterruptedIOSFileTransaction(rootPath))) return;
  const lockKey = await stableRootLockKey(rootPath);
  if (!lockKey) {
    throw transactionError(
      "recovery-failed",
      "The iOS file transaction recovery root could not be identified safely.",
    );
  }
  const recovery = withRootLock(lockKey, async () => recoverIOSFileTransactionsUnlocked(rootPath));
  recoveryByRoot.set(rootPath, recovery);
  try {
    await recovery;
  } finally {
    if (recoveryByRoot.get(rootPath) === recovery) recoveryByRoot.delete(rootPath);
  }
}

async function removeClaimedPath(
  claim: ClaimedDestination,
  options: { expectedHash?: string; expectedMode?: number } = {},
): Promise<void> {
  const currentIdentity = await readPathIdentity(claim.path);
  if (
    !claim.present ||
    !currentIdentity ||
    !sameFile(currentIdentity, claim.identity) ||
    (options.expectedMode !== undefined && currentIdentity.mode !== options.expectedMode) ||
    (options.expectedHash !== undefined &&
      !(await fileMatchesIdentityAndHash(claim.path, currentIdentity, options.expectedHash)))
  ) {
    throw new IOSFileTransactionOwnershipError(
      "a claimed path no longer identified the transaction's file",
    );
  }
  await rm(claim.path);
  claim.present = false;
  await syncDirectoryStrict(dirname(claim.path));
}

async function restoreClaimWithoutClobber(
  claim: ClaimedDestination,
  destinationPath: string,
): Promise<void> {
  try {
    await link(claim.path, destinationPath);
  } catch (error) {
    if (isFileSystemError(error, "EEXIST")) {
      const destinationIdentity = await readPathIdentity(destinationPath);
      if (destinationIdentity && sameFile(destinationIdentity, claim.identity)) {
        await syncDirectoryStrict(dirname(destinationPath));
        await removeClaimedPath(claim);
        await syncDirectoryStrict(dirname(destinationPath));
        return;
      }
    }
    throw new IOSFileTransactionOwnershipError(
      "a claimed destination could not be restored without overwriting newer filesystem state",
      { cause: error },
    );
  }

  const destinationIdentity = await readPathIdentity(destinationPath);
  const claimIdentity = await readPathIdentity(claim.path);
  if (
    !destinationIdentity ||
    !claimIdentity ||
    !sameFile(destinationIdentity, claim.identity) ||
    !sameFile(claimIdentity, claim.identity)
  ) {
    throw new IOSFileTransactionOwnershipError(
      "a restored destination no longer identified the transaction's claimed file",
    );
  }
  await syncDirectoryStrict(dirname(destinationPath));
  await removeClaimedPath(claim);
  await syncDirectoryStrict(dirname(destinationPath));
}

type ClaimDestinationResult =
  | { status: "claimed"; claim: ClaimedDestination }
  | { status: "stale" };

/**
 * Moves an existing destination to a unique same-directory name, then proves
 * which inode was moved. Unlike an overwriting rename, this never destroys a
 * replacement that arrives after the caller's last stale-input check.
 */
async function claimDestination(
  destinationPath: string,
  expectedIdentity: FileIdentity,
  expectedHash: string,
  claimedPath = transactionSiblingPath(destinationPath, "claimed"),
  expectedClaimParentIdentity?: DirectoryIdentity,
): Promise<ClaimDestinationResult> {
  if (expectedClaimParentIdentity) {
    const claimParentIdentity = await readDirectoryIdentity(dirname(claimedPath));
    if (
      !claimParentIdentity ||
      !directoryIdentitiesMatch(claimParentIdentity, expectedClaimParentIdentity) ||
      !(await pathIsAbsent(claimedPath))
    ) {
      throw new IOSFileTransactionOwnershipError(
        "the transaction-owned recovery claim was not empty and intact",
      );
    }
  }
  try {
    await rename(destinationPath, claimedPath);
    const destinationDirectory = dirname(destinationPath);
    const claimDirectory = dirname(claimedPath);
    // When the names live in different directories, make the recovery name
    // durable before making removal of the public name durable. A power loss
    // must never preserve the deletion while losing the only recoverable link.
    await syncDirectoryStrict(claimDirectory);
    if (destinationDirectory !== claimDirectory) {
      await syncDirectoryStrict(destinationDirectory);
    }
  } catch (error) {
    if (isFileSystemError(error, "ENOENT")) return { status: "stale" };
    throw error;
  }

  const movedIdentity = await readPathIdentity(claimedPath);
  if (expectedClaimParentIdentity) {
    const claimParentIdentity = await readDirectoryIdentity(dirname(claimedPath));
    if (
      !claimParentIdentity ||
      !directoryIdentitiesMatch(claimParentIdentity, expectedClaimParentIdentity)
    ) {
      throw new IOSFileTransactionOwnershipError(
        "the transaction-owned recovery directory changed during destination claim",
      );
    }
  }
  if (!movedIdentity) {
    throw new IOSFileTransactionOwnershipError(
      "a claimed destination could not be identified after it was moved",
    );
  }
  const claim: ClaimedDestination = {
    path: claimedPath,
    present: true,
    identity: movedIdentity,
  };
  const movedExpectedFile =
    identitiesMatch(movedIdentity, expectedIdentity) &&
    (await fileMatchesIdentityAndHash(claimedPath, expectedIdentity, expectedHash));
  if (movedExpectedFile) return { status: "claimed", claim };

  await restoreClaimWithoutClobber(claim, destinationPath);
  return { status: "stale" };
}

async function linkOwnedSourceWithoutClobber(
  sourcePath: string,
  sourceIdentity: FileIdentity,
  sourceHash: string,
  destinationPath: string,
): Promise<"linked" | "occupied"> {
  if (!(await fileMatchesIdentityAndHash(sourcePath, sourceIdentity, sourceHash))) {
    throw new IOSFileTransactionOwnershipError(
      "a transaction source changed before it could be installed",
    );
  }
  try {
    await link(sourcePath, destinationPath);
  } catch (error) {
    if (isFileSystemError(error, "EEXIST")) return "occupied";
    throw error;
  }

  const destinationIdentity = await readRegularFileIdentity(destinationPath);
  const sourceAfterLink = await readRegularFileIdentity(sourcePath);
  if (
    !destinationIdentity ||
    !sourceAfterLink ||
    !identitiesMatch(destinationIdentity, sourceIdentity) ||
    !identitiesMatch(sourceAfterLink, sourceIdentity) ||
    !(await fileMatchesIdentityAndHash(destinationPath, sourceIdentity, sourceHash))
  ) {
    throw new IOSFileTransactionOwnershipError(
      "an exclusively installed transaction source could not be identified",
    );
  }
  return "linked";
}

function isCreateMutation(mutation: IOSFileMutation): mutation is IOSCreateFileMutation {
  return "kind" in mutation && mutation.kind === "create";
}

function mutationBoundaryIsValid(mutation: IOSFileMutation): boolean {
  const { boundary } = mutation;
  return (
    boundary != null &&
    isAbsolute(boundary.rootPath) &&
    isAbsolute(boundary.realRootPath) &&
    isAbsolute(boundary.realParentPath) &&
    pathIsWithin(boundary.rootPath, mutation.path) &&
    pathIsWithin(boundary.realRootPath, boundary.realParentPath) &&
    Number.isSafeInteger(boundary.rootIdentity?.device) &&
    boundary.rootIdentity.device >= 0 &&
    Number.isSafeInteger(boundary.rootIdentity.inode) &&
    boundary.rootIdentity.inode >= 0 &&
    Number.isSafeInteger(boundary.parentIdentity?.device) &&
    boundary.parentIdentity.device >= 0 &&
    Number.isSafeInteger(boundary.parentIdentity.inode) &&
    boundary.parentIdentity.inode >= 0
  );
}

function validateMutations(mutations: readonly IOSFileMutation[]): void {
  if (mutations.length === 0) {
    throw transactionError(
      "invalid-mutation",
      "The iOS file transaction did not contain a file mutation.",
    );
  }

  const paths = new Set<string>();
  for (const mutation of mutations) {
    if (
      !mutation.path ||
      paths.has(mutation.path) ||
      !Number.isInteger(mutation.mode) ||
      mutation.mode < 0 ||
      mutation.mode > 0o7777 ||
      !mutationBoundaryIsValid(mutation) ||
      hashIOSFileBytes(mutation.candidateBytes) !== mutation.candidateHash ||
      (!isCreateMutation(mutation) &&
        hashIOSFileBytes(mutation.originalBytes) !== mutation.originalHash)
    ) {
      throw transactionError(
        "invalid-mutation",
        "The iOS file transaction contained an invalid or duplicate mutation.",
      );
    }
    paths.add(mutation.path);
  }
}

function snapshotMutations(mutations: readonly IOSFileMutation[]): IOSFileMutation[] {
  try {
    return mutations.map((mutation) => {
      if (!mutation.path || !isAbsolute(mutation.path)) {
        throw new Error("mutation path must be absolute");
      }
      const boundary: IOSFileMutationBoundary = {
        rootPath: resolve(mutation.boundary.rootPath),
        realRootPath: resolve(mutation.boundary.realRootPath),
        rootIdentity: { ...mutation.boundary.rootIdentity },
        realParentPath: resolve(mutation.boundary.realParentPath),
        parentIdentity: { ...mutation.boundary.parentIdentity },
      };
      if (isCreateMutation(mutation)) {
        return {
          kind: "create",
          path: resolve(mutation.path),
          boundary,
          candidateBytes: new Uint8Array(mutation.candidateBytes),
          candidateHash: mutation.candidateHash,
          mode: mutation.mode,
        };
      }
      return {
        path: resolve(mutation.path),
        boundary,
        originalBytes: new Uint8Array(mutation.originalBytes),
        originalHash: mutation.originalHash,
        candidateBytes: new Uint8Array(mutation.candidateBytes),
        candidateHash: mutation.candidateHash,
        mode: mutation.mode,
      };
    });
  } catch (error) {
    throw transactionError(
      "invalid-mutation",
      "The iOS file transaction contained an invalid mutation.",
      error,
    );
  }
}

async function stageBytes(
  mutation: IOSFileMutation,
  bytes: Uint8Array,
  expectedHash: string,
): Promise<StagedMutation> {
  const temporaryPath = resolve(
    dirname(mutation.path),
    `.${basename(mutation.path)}.clerk-${process.pid}-${randomUUID()}.tmp`,
  );
  let created = false;
  let openedIdentity: FileIdentity | undefined;
  try {
    if (!(await mutationBoundaryStillMatches(mutation))) {
      throw new IOSFileTransactionStaleError();
    }
    const temporary = await open(temporaryPath, "wx", mutation.mode);
    created = true;
    try {
      const info = await temporary.stat();
      if (!info.isFile()) throw new Error("staged path was not a regular file");
      openedIdentity = {
        dev: info.dev,
        ino: info.ino,
        mode: info.mode & 0o7777,
      };
      await temporary.writeFile(bytes);
      await temporary.chmod(mutation.mode);
      await temporary.sync();
    } finally {
      await temporary.close();
    }
    if (!(await fileMatchesHash(temporaryPath, expectedHash))) {
      throw new Error("staged bytes did not match their prepared hash");
    }
    const stagedIdentity = await readRegularFileIdentity(temporaryPath);
    if (!stagedIdentity || stagedIdentity.mode !== mutation.mode) {
      throw new Error("staged file identity did not match its prepared mode");
    }
    if (!(await mutationBoundaryStillMatches(mutation))) {
      throw new IOSFileTransactionStaleError();
    }
    return { mutation, temporaryPath, temporaryPresent: true, stagedIdentity };
  } catch (error) {
    if (created) {
      try {
        const currentIdentity = await readRegularFileIdentity(temporaryPath);
        if (!openedIdentity || !currentIdentity || !sameFile(currentIdentity, openedIdentity)) {
          throw new Error("the staged path no longer identified the transaction's file");
        }
        await rm(temporaryPath);
      } catch (cleanupError) {
        throw transactionError(
          "cleanup-failed",
          "A staged iOS file could not be removed after staging failed.",
          aggregateCause([error, cleanupError]),
        );
      }
    }
    if (error instanceof IOSFileTransactionStaleError) throw error;
    throw transactionError(
      "stage-failed",
      "The iOS file transaction could not be staged safely.",
      error,
    );
  }
}

async function cleanupStaged(staged: readonly StagedMutation[]): Promise<void> {
  const results = await Promise.allSettled(
    staged
      .filter((item) => item.temporaryPresent)
      .map(async (item) => {
        const currentIdentity = await readRegularFileIdentity(item.temporaryPath);
        if (!currentIdentity || !sameFile(currentIdentity, item.stagedIdentity)) {
          throw new Error("the staged path no longer identified the transaction's file");
        }
        await rm(item.temporaryPath);
        item.temporaryPresent = false;
      }),
  );
  const failures = results
    .filter((result): result is PromiseRejectedResult => result.status === "rejected")
    .map((result) => result.reason);
  if (failures.length > 0) {
    throw transactionError(
      "cleanup-failed",
      "One or more staged iOS files could not be removed.",
      aggregateCause(failures),
    );
  }
}

async function stageAll(
  mutations: readonly IOSFileMutation[],
  content: (mutation: IOSFileMutation) => { bytes: Uint8Array; hash: string },
): Promise<StagedMutation[]> {
  const staged: StagedMutation[] = [];
  try {
    for (const mutation of mutations) {
      const value = content(mutation);
      staged.push(await stageBytes(mutation, value.bytes, value.hash));
    }
    return staged;
  } catch (error) {
    try {
      await cleanupStaged(staged);
    } catch (cleanupError) {
      throw transactionError(
        "cleanup-failed",
        "The iOS file transaction failed to clean up after staging.",
        aggregateCause([error, cleanupError]),
      );
    }
    throw error;
  }
}

async function captureInitialExistingFileIdentities(
  mutations: readonly IOSFileMutation[],
): Promise<Map<string, FileIdentity> | undefined> {
  const identities = new Map<string, FileIdentity>();
  const states = await Promise.all(
    mutations.map(async (mutation) => {
      if (isCreateMutation(mutation)) {
        return (
          (await mutationBoundaryStillMatches(mutation)) && (await pathIsAbsent(mutation.path))
        );
      }
      if (!(await mutationBoundaryStillMatches(mutation))) return false;
      const identity = await readRegularFileIdentity(mutation.path);
      if (
        !identity ||
        identity.mode !== mutation.mode ||
        !(await fileMatchesIdentityAndHash(mutation.path, identity, mutation.originalHash))
      ) {
        return false;
      }
      identities.set(mutation.path, identity);
      return true;
    }),
  );
  return states.every(Boolean) ? identities : undefined;
}

async function originalStateStillMatches(
  mutation: IOSFileMutation,
  initialIdentities: ReadonlyMap<string, FileIdentity>,
): Promise<boolean> {
  if (isCreateMutation(mutation)) {
    return (await mutationBoundaryStillMatches(mutation)) && (await pathIsAbsent(mutation.path));
  }
  const identity = initialIdentities.get(mutation.path);
  return (
    (await mutationBoundaryStillMatches(mutation)) &&
    identity !== undefined &&
    fileMatchesIdentityAndHash(mutation.path, identity, mutation.originalHash)
  );
}

async function originalStatesStillMatch(
  mutations: readonly IOSFileMutation[],
  initialIdentities: ReadonlyMap<string, FileIdentity>,
): Promise<boolean> {
  const matches = await Promise.all(
    mutations.map(async (mutation) => originalStateStillMatches(mutation, initialIdentities)),
  );
  return matches.every(Boolean);
}

async function createdCandidateIsUntouched(item: StagedMutation): Promise<boolean> {
  if (!isCreateMutation(item.mutation) || !(await mutationBoundaryStillMatches(item.mutation))) {
    return false;
  }
  try {
    const destinationIdentity = await readRegularFileIdentity(item.mutation.path);
    if (
      !destinationIdentity ||
      !identitiesMatch(destinationIdentity, item.stagedIdentity) ||
      destinationIdentity.mode !== item.mutation.mode
    ) {
      return false;
    }
    if (item.temporaryPresent) {
      const temporaryIdentity = await readRegularFileIdentity(item.temporaryPath);
      if (!temporaryIdentity || !identitiesMatch(temporaryIdentity, item.stagedIdentity)) {
        return false;
      }
    }
    return (
      (await fileMatchesIdentityAndHash(
        item.mutation.path,
        item.committedIdentity ?? item.stagedIdentity,
        item.mutation.candidateHash,
      )) && (await mutationBoundaryStillMatches(item.mutation))
    );
  } catch {
    return false;
  }
}

async function committedCandidateIsUntouched(item: StagedMutation): Promise<boolean> {
  if (isCreateMutation(item.mutation)) return createdCandidateIsUntouched(item);
  if (!item.committedIdentity || !(await mutationBoundaryStillMatches(item.mutation))) return false;
  if (
    !(await fileMatchesIdentityAndHash(
      item.mutation.path,
      item.committedIdentity,
      item.mutation.candidateHash,
    ))
  ) {
    return false;
  }
  return (
    !item.temporaryPresent ||
    fileMatchesIdentityAndHash(item.temporaryPath, item.stagedIdentity, item.mutation.candidateHash)
  );
}

async function committedCandidatesAreUntouched(
  committed: readonly StagedMutation[],
): Promise<boolean> {
  const states = await Promise.all(committed.map(committedCandidateIsUntouched));
  return states.every(Boolean);
}

async function claimedOriginalIsUntouched(item: StagedMutation): Promise<boolean> {
  if (isCreateMutation(item.mutation)) return true;
  const claim = item.claimedOriginal;
  return (
    (await mutationBoundaryStillMatches(item.mutation)) &&
    claim !== undefined &&
    claim.present &&
    (await fileMatchesIdentityAndHash(claim.path, claim.identity, item.mutation.originalHash))
  );
}

async function claimedOriginalsAreUntouched(
  committed: readonly StagedMutation[],
): Promise<boolean> {
  const states = await Promise.all(committed.map(claimedOriginalIsUntouched));
  return states.every(Boolean);
}

async function cleanupClaimedOriginals(committed: readonly StagedMutation[]): Promise<void> {
  if (
    !(await committedCandidatesAreUntouched(committed)) ||
    !(await claimedOriginalsAreUntouched(committed))
  ) {
    throw new IOSFileTransactionOwnershipError(
      "one or more committed candidates or claimed originals changed before the originals could be released",
    );
  }
  const results = await Promise.allSettled(
    committed.map(async (item) => {
      if (isCreateMutation(item.mutation) || !item.claimedOriginal?.present) return;
      if (
        !(await committedCandidateIsUntouched(item)) ||
        !(await claimedOriginalIsUntouched(item))
      ) {
        throw new IOSFileTransactionOwnershipError(
          "a committed candidate or claimed original changed before the original could be released",
        );
      }
      await removeClaimedPath(item.claimedOriginal, {
        expectedHash: item.mutation.originalHash,
        expectedMode: item.mutation.mode,
      });
    }),
  );
  const failures = results
    .filter((result): result is PromiseRejectedResult => result.status === "rejected")
    .map((result) => result.reason);
  if (failures.length > 0) {
    const cause = aggregateCause(failures);
    if (failures.every((failure) => failure instanceof IOSFileTransactionOwnershipError)) {
      throw new IOSFileTransactionOwnershipError(
        "one or more committed candidates or claimed originals changed before the originals could be released",
        { cause },
      );
    }
    throw cause;
  }
}

async function rollbackCommitted(
  committed: readonly StagedMutation[],
  hooks: IOSFileTransactionTestHooks,
): Promise<void> {
  if (committed.length === 0) return;

  const reversed = [...committed].reverse();
  const rollbackClaims: Array<{
    claim: ClaimedDestination;
    mutation: IOSFileMutation;
  }> = [];

  try {
    // Restore every still-owned existing file before attempting to remove a
    // created dependency. A replaced create parent must not leave a project
    // file pointing at a destination the transaction can no longer prove.
    const candidatesAreUntouched = await Promise.all(
      reversed
        .filter((item) => !isCreateMutation(item.mutation))
        .map(committedCandidateIsUntouched),
    );
    if (!candidatesAreUntouched.every(Boolean)) {
      throw transactionError(
        "rollback-failed",
        "The iOS file transaction changed again before rollback; newer bytes were preserved.",
      );
    }

    for (const item of reversed) {
      if (!(await committedCandidateIsUntouched(item))) {
        throw transactionError(
          "rollback-failed",
          "The iOS file transaction changed again during rollback; newer bytes were preserved.",
        );
      }
      if (isCreateMutation(item.mutation)) {
        const candidateIdentity = item.committedIdentity ?? item.stagedIdentity;
        const claimResult = await claimDestination(
          item.mutation.path,
          candidateIdentity,
          item.mutation.candidateHash,
          item.rollbackClaimPath,
          item.recoveryDirectory?.identity,
        );
        if (claimResult.status === "stale") {
          throw transactionError(
            "rollback-failed",
            "The iOS file transaction changed again during rollback; newer bytes were preserved.",
          );
        }
        const candidateClaim = claimResult.claim;
        rollbackClaims.push({ claim: candidateClaim, mutation: item.mutation });
        await removeClaimedPath(candidateClaim, {
          expectedHash: item.mutation.candidateHash,
          expectedMode: item.mutation.mode,
        });
        await syncDirectoryStrict(dirname(item.mutation.path));
        if (
          !(await mutationBoundaryStillMatches(item.mutation)) ||
          !(await pathIsAbsent(item.mutation.path))
        ) {
          throw transactionError(
            "rollback-failed",
            "An iOS create destination changed while rollback removed its candidate; newer filesystem state was preserved.",
          );
        }
        continue;
      }
      const originalBackup = item.claimedOriginal?.present ? item.claimedOriginal : undefined;
      if (!originalBackup) {
        throw new IOSFileTransactionOwnershipError(
          "the original iOS file claim was missing during rollback",
        );
      }
      const originalSourcePath = originalBackup.path;
      const originalSource = await readRegularFileIdentityAndHash(originalSourcePath);
      if (!originalSource || !sameFile(originalSource.identity, originalBackup.identity)) {
        throw new IOSFileTransactionOwnershipError(
          "the original iOS file could not be identified during rollback",
        );
      }
      const originalSourceIdentity = originalSource.identity;
      const originalSourceHash = originalSource.hash;
      // Rollback uses the same non-overwriting boundary as commit: preserve
      // the actual public inode first, then restore through an exclusive link.
      await hooks.beforeRollbackDestinationClaim?.(item.mutation.path);
      if (!(await mutationBoundaryStillMatches(item.mutation))) {
        throw transactionError(
          "rollback-failed",
          "The iOS mutation boundary changed during rollback; newer filesystem state was preserved.",
        );
      }
      const candidateIdentity = item.committedIdentity ?? item.stagedIdentity;
      const candidateClaimResult = await claimDestination(
        item.mutation.path,
        candidateIdentity,
        item.mutation.candidateHash,
        item.rollbackClaimPath,
        item.recoveryDirectory?.identity,
      );
      if (candidateClaimResult.status === "stale") {
        throw transactionError(
          "rollback-failed",
          "The iOS file transaction changed again during rollback; newer bytes were preserved.",
        );
      }
      const candidateClaim = candidateClaimResult.claim;
      rollbackClaims.push({ claim: candidateClaim, mutation: item.mutation });
      let sourceInstalled = false;
      try {
        await hooks.afterRollbackDestinationClaim?.(item.mutation.path, candidateClaim.path);
        if (
          !(await mutationBoundaryStillMatches(item.mutation)) ||
          !(await fileMatchesIdentityAndHash(
            originalSourcePath,
            originalSourceIdentity,
            originalSourceHash,
          ))
        ) {
          throw new IOSFileTransactionOwnershipError(
            "the original iOS file changed before rollback installation",
          );
        }
        await hooks.beforeRollbackDestinationInstall?.(
          item.mutation.path,
          originalSourcePath,
          candidateClaim.path,
        );
        if (!(await mutationBoundaryStillMatches(item.mutation))) {
          throw transactionError(
            "rollback-failed",
            "The iOS mutation boundary changed during rollback; newer filesystem state was preserved.",
          );
        }
        const installResult = await linkOwnedSourceWithoutClobber(
          originalSourcePath,
          originalSourceIdentity,
          originalSourceHash,
          item.mutation.path,
        );
        if (installResult === "occupied") {
          throw transactionError(
            "rollback-failed",
            "The iOS file transaction changed again during rollback; newer bytes were preserved.",
          );
        }
        sourceInstalled = true;
        await syncDirectoryStrict(dirname(item.mutation.path));
        await hooks.afterRollbackDestinationInstall?.(item.mutation.path);
        if (!(await mutationBoundaryStillMatches(item.mutation))) {
          throw transactionError(
            "rollback-failed",
            "The iOS mutation boundary changed during rollback; newer filesystem state was preserved.",
          );
        }
        const restoredIdentity = await readRegularFileIdentity(item.mutation.path);
        if (
          !restoredIdentity ||
          !sameFile(restoredIdentity, originalSourceIdentity) ||
          !(await fileMatchesIdentityAndHash(
            item.mutation.path,
            originalSourceIdentity,
            originalSourceHash,
          ))
        ) {
          throw new IOSFileTransactionOwnershipError(
            "the restored iOS file did not match its rollback source",
          );
        }
        await removeClaimedPath(candidateClaim, {
          expectedHash: item.mutation.candidateHash,
          expectedMode: item.mutation.mode,
        });
        await removeClaimedPath(originalBackup, {
          expectedHash: originalSourceHash,
          expectedMode: originalSourceIdentity.mode,
        });
        await syncDirectoryStrict(dirname(item.mutation.path));
      } catch (error) {
        if (
          !sourceInstalled &&
          (await mutationBoundaryStillMatches(item.mutation)) &&
          (await pathIsAbsent(item.mutation.path))
        ) {
          try {
            await restoreClaimWithoutClobber(candidateClaim, item.mutation.path);
          } catch (restoreError) {
            throw new IOSFileTransactionOwnershipError(
              "the claimed candidate could not be restored after rollback stopped",
              { cause: aggregateCause([error, restoreError]) },
            );
          }
        }
        throw error;
      }
    }
  } catch (error) {
    let candidateClaimCleanupError: unknown;
    const candidateClaimCleanupResults = await Promise.allSettled(
      rollbackClaims.map(async ({ claim, mutation }) => {
        if (!claim.present) return;
        await removeClaimedPath(claim, {
          expectedHash: mutation.candidateHash,
          expectedMode: mutation.mode,
        });
      }),
    );
    const candidateClaimCleanupFailures = candidateClaimCleanupResults
      .filter((result): result is PromiseRejectedResult => result.status === "rejected")
      .map((result) => result.reason);
    if (candidateClaimCleanupFailures.length > 0) {
      candidateClaimCleanupError = aggregateCause(candidateClaimCleanupFailures);
    }
    if (candidateClaimCleanupError) {
      throw transactionError(
        "rollback-failed",
        "The iOS file transaction could not be rolled back or cleaned up completely.",
        aggregateCause([error, candidateClaimCleanupError].filter((cause) => cause !== undefined)),
      );
    }
    if (error instanceof IOSFileTransactionError && error.code === "rollback-failed") throw error;
    throw transactionError(
      "rollback-failed",
      "The iOS file transaction could not be rolled back completely.",
      error,
    );
  }
}

async function rollbackAfterFailure(
  committed: readonly StagedMutation[],
  staged: readonly StagedMutation[],
  hooks: IOSFileTransactionTestHooks,
): Promise<void> {
  let rollbackError: unknown;
  let cleanupError: unknown;
  try {
    await rollbackCommitted(committed, hooks);
  } catch (error) {
    rollbackError = error;
  }
  try {
    await cleanupStaged(staged);
  } catch (error) {
    cleanupError = error;
  }
  if (!(await mutationBoundariesStillMatch(committed.map((item) => item.mutation)))) {
    cleanupError ??= transactionError(
      "rollback-failed",
      "An iOS mutation boundary changed while rollback was being finalized; newer filesystem state was preserved.",
    );
  }
  if (rollbackError || cleanupError) {
    throw transactionError(
      "rollback-failed",
      "The iOS file transaction could not be rolled back or cleaned up completely.",
      aggregateCause([rollbackError, cleanupError].filter((error) => error !== undefined)),
    );
  }
}

async function syncTransactionDirectories(staged: readonly StagedMutation[]): Promise<void> {
  const directories = new Set(staged.map((item) => dirname(item.mutation.path)));
  for (const directory of directories) await syncDirectoryStrict(directory);
}

async function rollbackDurableTransaction(
  committed: readonly StagedMutation[],
  staged: readonly StagedMutation[],
  hooks: IOSFileTransactionTestHooks,
  journal: IOSFileTransactionJournal,
): Promise<void> {
  try {
    await rollbackAfterFailure(committed, staged, hooks);
    await syncTransactionDirectories(staged);
    try {
      await removeTransactionJournal(journal);
    } catch (error) {
      if (isFileSystemError(error, "ENOTEMPTY")) {
        activeJournalPaths.delete(journal.path);
        return;
      }
      throw error;
    }
  } catch (error) {
    activeJournalPaths.delete(journal.path);
    if (committed.every((item) => isCreateMutation(item.mutation))) {
      try {
        activeJournalPaths.add(journal.path);
        await recoverTransactionJournal(journal);
      } catch {
        // Keep the durable journal and verified artifacts for the next startup
        // when immediate recovery cannot safely converge the filesystem.
      } finally {
        activeJournalPaths.delete(journal.path);
      }
    }
    throw error;
  }
}

async function postconditionsAreValid(
  postconditions: readonly IOSFilePostcondition[],
): Promise<boolean> {
  const results = await Promise.allSettled(
    postconditions.map(async (postcondition) => Promise.resolve().then(postcondition)),
  );
  return results.every((result) => result.status === "fulfilled" && result.value === true);
}

/**
 * Atomically creates or replaces a set of files as far as the filesystem
 * allows. Candidates are all staged first; any partial commit is restored in
 * reverse order if a later commit or aggregate postcondition fails.
 *
 * @internal Prepared mutations contain sensitive-to-output candidate bytes.
 */
export async function applyIOSFileTransaction(
  mutations: readonly IOSFileMutation[],
  postconditions: readonly IOSFilePostcondition[],
  hooks: IOSFileTransactionTestHooks = {},
): Promise<IOSFileTransactionResult> {
  const prepared = snapshotMutations(mutations);
  validateMutations(prepared);
  const rootPath = transactionRoot(prepared);
  if (!(await mutationBoundariesStillMatch(prepared))) return { status: "stale" };
  const lockKey = await stableRootLockKey(rootPath);
  if (!lockKey) return { status: "stale" };
  return withRootLock(
    lockKey,
    async () => {
      if (!(await mutationBoundariesStillMatch(prepared))) return { status: "stale" };
      return applyPreparedIOSFileTransaction(prepared, postconditions, hooks, rootPath);
    },
    hooks.beforeRootLockPublication,
  );
}

async function applyPreparedIOSFileTransaction(
  prepared: readonly IOSFileMutation[],
  postconditions: readonly IOSFilePostcondition[],
  hooks: IOSFileTransactionTestHooks,
  rootPath: string,
): Promise<IOSFileTransactionResult> {
  await recoverIOSFileTransactions(rootPath);
  const initialIdentities = await captureInitialExistingFileIdentities(prepared);
  if (!initialIdentities) return { status: "stale" };
  let staged: StagedMutation[];
  try {
    staged = await stageAll(prepared, (mutation) => ({
      bytes: mutation.candidateBytes,
      hash: mutation.candidateHash,
    }));
  } catch (error) {
    if (error instanceof IOSFileTransactionStaleError) return { status: "stale" };
    throw error;
  }
  const committed: StagedMutation[] = [];

  if (!(await originalStatesStillMatch(prepared, initialIdentities))) {
    await cleanupStaged(staged);
    return { status: "stale" };
  }

  let journal: IOSFileTransactionJournal;
  try {
    journal = await createTransactionJournal(
      staged,
      hooks.beforeRecoveryJournalPublication,
      hooks.afterInitialRecoveryJournalPublication,
    );
  } catch (error) {
    if (!(error instanceof IOSFileTransactionUnsafeSetupCleanupError)) {
      try {
        await cleanupStaged(staged);
      } catch (cleanupError) {
        throw transactionError(
          "cleanup-failed",
          "The iOS file transaction could not clean up after recovery setup failed.",
          aggregateCause([error, cleanupError]),
        );
      }
      if (error instanceof IOSFileTransactionStaleError) return { status: "stale" };
    }
    throw transactionError(
      "stage-failed",
      "The iOS file transaction could not prepare durable recovery state.",
      error,
    );
  }
  try {
    await hooks.afterRecoveryJournalPublished?.(journal.path);
  } catch (error) {
    await rollbackDurableTransaction([], staged, hooks, journal);
    throw transactionError(
      "commit-failed",
      "The iOS file transaction stopped after preparing durable recovery state.",
      error,
    );
  }

  let stale = false;
  let commitError: unknown;
  for (const item of staged) {
    if (!(await mutationBoundariesStillMatch(prepared))) {
      stale = true;
      break;
    }
    const originalStillMatches = await originalStateStillMatches(item.mutation, initialIdentities);
    if (!originalStillMatches) {
      stale = true;
      break;
    }
    let committedThisItem = false;
    try {
      if (isCreateMutation(item.mutation)) {
        await link(item.temporaryPath, item.mutation.path);
      } else {
        const expectedIdentity = initialIdentities.get(item.mutation.path);
        if (!expectedIdentity) {
          throw new Error("an existing iOS file identity was missing during commit");
        }
        // Portable Node APIs do not expose an inode-conditional replacement.
        // Move whichever inode actually owns the destination into recovery,
        // verify it, then link the candidate only while the public path is
        // absent. A concurrent writer therefore wins with EEXIST instead of
        // being overwritten.
        await hooks.beforeExistingDestinationClaim?.(item.mutation.path);
        if (!(await mutationBoundariesStillMatch(prepared))) {
          stale = true;
          break;
        }
        const claimResult = await claimDestination(
          item.mutation.path,
          expectedIdentity,
          item.mutation.originalHash,
          item.originalClaimPath,
          item.recoveryDirectory?.identity,
        );
        if (claimResult.status === "stale") {
          stale = true;
          break;
        }
        item.claimedOriginal = claimResult.claim;
        await hooks.afterExistingDestinationClaim?.(item.mutation.path, item.claimedOriginal.path);
        if (
          !(await mutationBoundariesStillMatch(prepared)) ||
          !(await claimedOriginalIsUntouched(item)) ||
          !(await fileMatchesIdentityAndHash(
            item.temporaryPath,
            item.stagedIdentity,
            item.mutation.candidateHash,
          ))
        ) {
          throw new IOSFileTransactionStaleError();
        }
        await hooks.beforeExistingDestinationInstall?.(
          item.mutation.path,
          item.claimedOriginal.path,
        );
        if (
          !(await mutationBoundariesStillMatch(prepared)) ||
          !(await claimedOriginalIsUntouched(item))
        ) {
          throw new IOSFileTransactionStaleError();
        }
        const installResult = await linkOwnedSourceWithoutClobber(
          item.temporaryPath,
          item.stagedIdentity,
          item.mutation.candidateHash,
          item.mutation.path,
        );
        if (installResult === "occupied") {
          await removeClaimedPath(item.claimedOriginal, {
            expectedHash: item.mutation.originalHash,
            expectedMode: item.mutation.mode,
          });
          await syncDirectoryStrict(dirname(item.mutation.path));
          stale = true;
          break;
        }
      }
      // A successful exclusive link proves that the
      // destination referred to the staged inode at the commit linearization
      // point. Record ownership synchronously before exposing it to rollback.
      item.committedIdentity = item.stagedIdentity;
      committed.push(item);
      committedThisItem = true;
      if (!isCreateMutation(item.mutation) && item.claimedOriginal) {
        await hooks.afterExistingDestinationInstall?.(
          item.mutation.path,
          item.claimedOriginal.path,
        );
      }
      if (!(await mutationBoundariesStillMatch(prepared))) {
        throw new IOSFileTransactionStaleError();
      }
      const committedIdentity = await readRegularFileIdentity(item.mutation.path);
      if (!committedIdentity || !identitiesMatch(committedIdentity, item.stagedIdentity)) {
        throw new Error("committed file identity did not match its staged candidate");
      }
      item.committedIdentity = committedIdentity;
      await syncDirectoryStrict(dirname(item.mutation.path));
      if (!(await mutationBoundariesStillMatch(prepared))) {
        throw new IOSFileTransactionStaleError();
      }
    } catch (error) {
      let effectiveError = error;
      // A successful claim removed the public destination. Recovery must run
      // even if its parent moved afterward: restoration uses an exclusive
      // link, so a newer destination wins without being overwritten. If the
      // claimed inode can no longer be restored safely, escalate explicitly
      // instead of returning stale with the original stranded under its claim.
      if (!committedThisItem && item.claimedOriginal?.present) {
        try {
          await restoreClaimWithoutClobber(item.claimedOriginal, item.mutation.path);
        } catch (cleanupError) {
          effectiveError = new IOSFileTransactionOwnershipError(
            "a claimed original could not be restored after commit stopped",
            { cause: aggregateCause([error, cleanupError]) },
          );
        }
      }
      if (
        effectiveError instanceof IOSFileTransactionStaleError ||
        (isCreateMutation(item.mutation) && isFileSystemError(effectiveError, "EEXIST"))
      ) {
        stale = true;
      } else {
        commitError = effectiveError;
      }
      break;
    }
  }

  if (stale || commitError) {
    await rollbackDurableTransaction(committed, staged, hooks, journal);
    if (stale) return { status: "stale" };
    throw transactionError(
      "commit-failed",
      "The iOS file transaction could not be committed and was restored.",
      commitError,
    );
  }

  const boundariesMatchedBeforePostvalidation = await mutationBoundariesStillMatch(prepared);
  const candidatesMatchedBeforePostvalidation = await committedCandidatesAreUntouched(committed);
  const originalsMatchedBeforePostvalidation = await claimedOriginalsAreUntouched(committed);
  const postconditionsValid = await postconditionsAreValid(postconditions);
  const boundariesMatchedAfterPostvalidation = await mutationBoundariesStillMatch(prepared);
  const candidatesMatchedAfterPostvalidation = await committedCandidatesAreUntouched(committed);
  const originalsMatchedAfterPostvalidation = await claimedOriginalsAreUntouched(committed);
  if (
    boundariesMatchedBeforePostvalidation &&
    candidatesMatchedBeforePostvalidation &&
    originalsMatchedBeforePostvalidation &&
    postconditionsValid &&
    boundariesMatchedAfterPostvalidation &&
    candidatesMatchedAfterPostvalidation &&
    originalsMatchedAfterPostvalidation
  ) {
    try {
      await markTransactionCommitted(journal);
      await hooks.afterDurableCommit?.(journal.path);
      await cleanupClaimedOriginals(committed);
      await cleanupStaged(staged);
      await syncTransactionDirectories(staged);
      await hooks.afterCommittedArtifactCleanup?.(journal.path);
      await removeTransactionJournal(journal);
      return { status: "applied" };
    } catch (error) {
      if (journal.record.state === "pending") {
        await rollbackDurableTransaction(committed, staged, hooks, journal);
        if (error instanceof IOSFileTransactionOwnershipError) return { status: "stale" };
        throw transactionError(
          "commit-failed",
          "The iOS file transaction could not durably commit and was restored.",
          error,
        );
      }
      activeJournalPaths.delete(journal.path);
      throw transactionError(
        "cleanup-failed",
        "The committed iOS file transaction could not finish cleaning up its recovery artifacts.",
        error,
      );
    }
  }

  await rollbackDurableTransaction(committed, staged, hooks, journal);
  return boundariesMatchedBeforePostvalidation &&
    candidatesMatchedBeforePostvalidation &&
    boundariesMatchedAfterPostvalidation &&
    candidatesMatchedAfterPostvalidation &&
    originalsMatchedBeforePostvalidation &&
    originalsMatchedAfterPostvalidation
    ? { status: "rolled-back" }
    : { status: "stale" };
}

/**
 * Atomically replaces a set of existing files as far as the filesystem allows.
 *
 * @internal Prepared mutations contain sensitive-to-output candidate bytes.
 */
export async function applyIOSExistingFileTransaction(
  mutations: readonly IOSExistingFileMutation[],
  postconditions: readonly IOSFilePostcondition[],
  hooks: IOSFileTransactionTestHooks = {},
): Promise<IOSFileTransactionResult> {
  return applyIOSFileTransaction(mutations, postconditions, hooks);
}
