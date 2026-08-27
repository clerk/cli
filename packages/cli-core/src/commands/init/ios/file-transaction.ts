import { link, lstat, open, readFile, realpath, rename, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
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
  | "rollback-failed";

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

class IOSFileTransactionStaleError extends Error {}

class IOSFileTransactionOwnershipError extends Error {}

/**
 * Deterministic race hooks used only by the file-transaction regression tests.
 *
 * @internal
 */
export interface IOSFileTransactionTestHooks {
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

async function syncDirectory(path: string): Promise<void> {
  try {
    const directory = await open(path, "r");
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  } catch {
    // Same-directory rename remains atomic even when directory fsync is not
    // available on the current filesystem.
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

function transactionSiblingPath(path: string, purpose: string): string {
  return resolve(
    dirname(path),
    `.${basename(path)}.clerk-${process.pid}-${randomUUID()}.${purpose}`,
  );
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
        await removeClaimedPath(claim);
        await syncDirectory(dirname(destinationPath));
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
  await removeClaimedPath(claim);
  await syncDirectory(dirname(destinationPath));
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
): Promise<ClaimDestinationResult> {
  const claimedPath = transactionSiblingPath(destinationPath, "claimed");
  try {
    await rename(destinationPath, claimedPath);
  } catch (error) {
    if (isFileSystemError(error, "ENOENT")) return { status: "stale" };
    throw error;
  }

  const movedIdentity = await readPathIdentity(claimedPath);
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
  const rollbackFiles = await stageAll(
    reversed
      .map((item) => item.mutation)
      .filter((mutation): mutation is IOSExistingFileMutation => !isCreateMutation(mutation)),
    (mutation) => {
      if (isCreateMutation(mutation)) {
        throw new Error("create mutations do not have original bytes");
      }
      return { bytes: mutation.originalBytes, hash: mutation.originalHash };
    },
  );

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

    let rollbackIndex = 0;
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
        await syncDirectory(dirname(item.mutation.path));
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
      const rollback = rollbackFiles[rollbackIndex++];
      if (!rollback) {
        throw new Error("a prepared rollback file was missing");
      }
      const originalBackup = item.claimedOriginal?.present ? item.claimedOriginal : undefined;
      const originalSourcePath = originalBackup?.path ?? rollback.temporaryPath;
      const originalSource = await readRegularFileIdentityAndHash(originalSourcePath);
      if (
        !originalSource ||
        (originalBackup && !sameFile(originalSource.identity, originalBackup.identity)) ||
        (!originalBackup &&
          (!identitiesMatch(originalSource.identity, rollback.stagedIdentity) ||
            originalSource.hash !== item.mutation.originalHash))
      ) {
        throw new IOSFileTransactionOwnershipError(
          "the original iOS file could not be identified during rollback",
        );
      }
      const originalSourceIdentity = originalSource.identity;
      const originalSourceHash = originalSource.hash;
      // Rollback uses the same non-overwriting boundary as commit: preserve
      // the actual public inode first, then restore through an exclusive link.
      await hooks.beforeRollbackDestinationClaim?.(rollback.mutation.path);
      if (!(await mutationBoundaryStillMatches(rollback.mutation))) {
        throw transactionError(
          "rollback-failed",
          "The iOS mutation boundary changed during rollback; newer filesystem state was preserved.",
        );
      }
      const candidateIdentity = item.committedIdentity ?? item.stagedIdentity;
      const candidateClaimResult = await claimDestination(
        rollback.mutation.path,
        candidateIdentity,
        item.mutation.candidateHash,
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
        await hooks.afterRollbackDestinationClaim?.(rollback.mutation.path, candidateClaim.path);
        if (
          !(await mutationBoundaryStillMatches(rollback.mutation)) ||
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
          rollback.mutation.path,
          originalSourcePath,
          candidateClaim.path,
        );
        if (!(await mutationBoundaryStillMatches(rollback.mutation))) {
          throw transactionError(
            "rollback-failed",
            "The iOS mutation boundary changed during rollback; newer filesystem state was preserved.",
          );
        }
        const installResult = await linkOwnedSourceWithoutClobber(
          originalSourcePath,
          originalSourceIdentity,
          originalSourceHash,
          rollback.mutation.path,
        );
        if (installResult === "occupied") {
          throw transactionError(
            "rollback-failed",
            "The iOS file transaction changed again during rollback; newer bytes were preserved.",
          );
        }
        sourceInstalled = true;
        await hooks.afterRollbackDestinationInstall?.(rollback.mutation.path);
        if (!(await mutationBoundaryStillMatches(rollback.mutation))) {
          throw transactionError(
            "rollback-failed",
            "The iOS mutation boundary changed during rollback; newer filesystem state was preserved.",
          );
        }
        const restoredIdentity = await readRegularFileIdentity(rollback.mutation.path);
        if (
          !restoredIdentity ||
          !sameFile(restoredIdentity, originalSourceIdentity) ||
          !(await fileMatchesIdentityAndHash(
            rollback.mutation.path,
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
        if (originalBackup) {
          await removeClaimedPath(originalBackup, {
            expectedHash: originalSourceHash,
            expectedMode: originalSourceIdentity.mode,
          });
        }
        await syncDirectory(dirname(rollback.mutation.path));
      } catch (error) {
        if (
          !sourceInstalled &&
          (await mutationBoundaryStillMatches(rollback.mutation)) &&
          (await pathIsAbsent(rollback.mutation.path))
        ) {
          try {
            await restoreClaimWithoutClobber(candidateClaim, rollback.mutation.path);
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
    await cleanupStaged(rollbackFiles);
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
    try {
      await cleanupStaged(rollbackFiles);
    } catch (cleanupError) {
      throw transactionError(
        "rollback-failed",
        "The iOS file transaction could not be rolled back or cleaned up completely.",
        aggregateCause(
          [error, candidateClaimCleanupError, cleanupError].filter((cause) => cause !== undefined),
        ),
      );
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
          await syncDirectory(dirname(item.mutation.path));
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
      await syncDirectory(dirname(item.mutation.path));
      if (!(await mutationBoundariesStillMatch(prepared))) {
        throw new IOSFileTransactionStaleError();
      }
    } catch (error) {
      let effectiveError = error;
      if (
        !committedThisItem &&
        item.claimedOriginal?.present &&
        (await mutationBoundaryStillMatches(item.mutation))
      ) {
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
    await rollbackAfterFailure(committed, staged, hooks);
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
      await cleanupClaimedOriginals(committed);
    } catch (error) {
      await rollbackAfterFailure(committed, staged, hooks);
      if (error instanceof IOSFileTransactionOwnershipError) return { status: "stale" };
      throw transactionError(
        "cleanup-failed",
        "The iOS file transaction could not release its claimed original files and was restored.",
        error,
      );
    }
    await cleanupStaged(staged);
    if (
      (await mutationBoundariesStillMatch(prepared)) &&
      (await committedCandidatesAreUntouched(committed))
    ) {
      return { status: "applied" };
    }
    await rollbackAfterFailure(committed, staged, hooks);
    return { status: "stale" };
  }

  await rollbackAfterFailure(committed, staged, hooks);
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
