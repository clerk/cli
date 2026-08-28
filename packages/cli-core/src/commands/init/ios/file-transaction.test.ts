import { afterEach, describe, expect, test } from "bun:test";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import {
  applyIOSExistingFileTransaction,
  applyIOSFileTransaction,
  hashIOSFileBytes,
  IOSFileTransactionError,
  prepareIOSFileMutationBoundary,
  recoverIOSFileTransactions,
  type IOSCreateFileMutation,
  type IOSExistingFileMutation,
} from "./file-transaction.ts";

const temporaryDirectories: string[] = [];
const FILE_TRANSACTION_MODULE = `${import.meta.dir}/file-transaction.ts`;

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "clerk-ios-file-transaction-"));
  temporaryDirectories.push(root);
  return root;
}

async function mutation(
  path: string,
  candidate: string,
  root = dirname(path),
): Promise<IOSExistingFileMutation> {
  const originalBytes = new Uint8Array(await readFile(path));
  const candidateBytes = new TextEncoder().encode(candidate);
  const info = await lstat(path);
  const boundary = await prepareIOSFileMutationBoundary(root, path);
  if (!boundary) throw new Error("expected a safe file mutation boundary");
  return {
    path,
    boundary,
    originalBytes,
    originalHash: hashIOSFileBytes(originalBytes),
    candidateBytes,
    candidateHash: hashIOSFileBytes(candidateBytes),
    mode: info.mode & 0o7777,
  };
}

async function createMutation(
  path: string,
  candidate: string,
  mode = 0o644,
  root = dirname(path),
): Promise<IOSCreateFileMutation> {
  const candidateBytes = new TextEncoder().encode(candidate);
  const boundary = await prepareIOSFileMutationBoundary(root, path);
  if (!boundary) throw new Error("expected a safe file mutation boundary");
  return {
    kind: "create",
    path,
    boundary,
    candidateBytes,
    candidateHash: hashIOSFileBytes(candidateBytes),
    mode,
  };
}

async function expectNoTemporaryFiles(root: string): Promise<void> {
  expect((await readdir(root)).filter((name) => name.includes(".clerk-"))).toEqual([]);
}

async function expectRecoverableClaimedOriginals(
  root: string,
  expectedContents: string[],
): Promise<void> {
  const entries = await readdir(root, { withFileTypes: true });
  const transactionFiles = entries.filter((entry) => entry.name.includes(".clerk-"));
  const claimedOriginals = transactionFiles
    .filter((entry) => entry.isFile() && entry.name.endsWith(".claimed"))
    .map((entry) => join(root, entry.name));
  for (const entry of transactionFiles.filter(
    (entry) => entry.isDirectory() && entry.name.endsWith(".recovery"),
  )) {
    const originalPath = join(root, entry.name, "original");
    if (await Bun.file(originalPath).exists()) claimedOriginals.push(originalPath);
  }
  expect(transactionFiles.filter((entry) => entry.name.endsWith(".tmp"))).toEqual([]);
  expect(
    (await Promise.all(claimedOriginals.map((path) => readFile(path, "utf8")))).sort(),
  ).toEqual([...expectedContents].sort());
}

async function crashFileTransaction(
  root: string,
  paths: string[],
  phase: "lock-publication" | "journal-publication" | "claim" | "rollback-claim" | "committed",
  killAfter = 1,
): Promise<string | undefined> {
  const publicationMarker = join(root, `.publication-${phase}`);
  const source = `
    const { readFile, lstat, writeFile } = await import("node:fs/promises");
    const {
      applyIOSExistingFileTransaction,
      hashIOSFileBytes,
      prepareIOSFileMutationBoundary,
    } = await import(${JSON.stringify(FILE_TRANSACTION_MODULE)});
    const root = ${JSON.stringify(root)};
    const paths = ${JSON.stringify(paths)};
    const mutations = [];
    for (const [index, path] of paths.entries()) {
      const originalBytes = new Uint8Array(await readFile(path));
      const candidateBytes = new TextEncoder().encode("candidate " + index + "\\n");
      const boundary = await prepareIOSFileMutationBoundary(root, path);
      const info = await lstat(path);
      mutations.push({
        path,
        boundary,
        originalBytes,
        originalHash: hashIOSFileBytes(originalBytes),
        candidateBytes,
        candidateHash: hashIOSFileBytes(candidateBytes),
        mode: info.mode & 0o7777,
      });
    }
    let claims = 0;
    const crash = () => process.kill(process.pid, "SIGKILL");
    const crashDuringPublication = async (path) => {
      await writeFile(${JSON.stringify(publicationMarker)}, path, "utf8");
      crash();
    };
    const hooks =
      ${JSON.stringify(phase)} === "lock-publication"
        ? { beforeRootLockPublication: crashDuringPublication }
        : ${JSON.stringify(phase)} === "journal-publication"
          ? { beforeRecoveryJournalPublication: crashDuringPublication }
          : ${JSON.stringify(phase)} === "claim"
            ? { afterExistingDestinationClaim: () => { if (++claims === ${killAfter}) crash(); } }
            : ${JSON.stringify(phase)} === "rollback-claim"
              ? { afterRollbackDestinationClaim: crash }
              : { afterDurableCommit: crash };
    const postconditions = ${JSON.stringify(phase)} === "rollback-claim"
      ? [async () => false]
      : [async () => true];
    await applyIOSExistingFileTransaction(mutations, postconditions, hooks);
    process.exit(97);
  `;
  const child = Bun.spawn([process.execPath, "-e", source], {
    stdout: "ignore",
    stderr: "ignore",
  });
  await child.exited;
  expect(child.signalCode).toBe("SIGKILL");
  if (!phase.endsWith("publication")) return undefined;
  return readFile(publicationMarker, "utf8");
}

async function waitForCondition(condition: () => boolean | Promise<boolean>): Promise<void> {
  for (let attempt = 0; attempt < 5_000; attempt++) {
    if (await condition()) return;
    await Bun.sleep(1);
  }
  throw new Error("Timed out waiting for the file transaction test condition.");
}

async function waitForStagingFile(root: string): Promise<void> {
  await waitForCondition(async () =>
    (await readdir(root)).some((name) => name.includes(".clerk-") && name.endsWith(".tmp")),
  );
}

function errorText(value: unknown, seen = new Set<unknown>()): string {
  if (value == null || seen.has(value)) return "";
  if (typeof value !== "object") return String(value);
  seen.add(value);
  if (value instanceof AggregateError) {
    return `${value.name}: ${value.message}\n${value.errors
      .map((error) => errorText(error, seen))
      .join("\n")}`;
  }
  if (value instanceof Error) {
    return `${value.name}: ${value.message}\n${errorText(value.cause, seen)}`;
  }
  return "";
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("iOS existing-file transaction", () => {
  test("preserves an out-of-root file when its prepared parent is replaced before claim", async () => {
    const root = await temporaryRoot();
    const projectRoot = join(root, "project");
    const preparedParent = join(projectRoot, "Sources");
    const outsideRoot = join(root, "outside");
    const displacedParent = join(outsideRoot, "Sources");
    const path = join(preparedParent, "App.swift");
    await mkdir(preparedParent, { recursive: true });
    await mkdir(outsideRoot);
    await writeFile(path, "original source\n");
    const prepared = await mutation(path, "candidate source\n", projectRoot);

    const result = await applyIOSExistingFileTransaction([prepared], [async () => true], {
      beforeExistingDestinationClaim: async () => {
        await rename(preparedParent, displacedParent);
        await symlink(displacedParent, preparedParent, "dir");
      },
    });

    expect(result).toEqual({ status: "stale" });
    expect(await readFile(join(displacedParent, "App.swift"), "utf8")).toBe("original source\n");
    expect(await readFile(path, "utf8")).toBe("original source\n");
    await expectNoTemporaryFiles(displacedParent);
  });

  test.each([
    ["after destination claim", "afterExistingDestinationClaim"],
    ["immediately before destination install", "beforeExistingDestinationInstall"],
  ] as const)("restores a claimed original when its parent moves %s", async (_label, hook) => {
    const root = await temporaryRoot();
    const projectRoot = join(root, "project");
    const preparedParent = join(projectRoot, "Sources");
    const outsideRoot = join(root, "outside");
    const displacedParent = join(outsideRoot, "Sources");
    const path = join(preparedParent, "App.swift");
    await mkdir(preparedParent, { recursive: true });
    await mkdir(outsideRoot);
    await writeFile(path, "original source\n");
    await chmod(path, 0o640);
    const originalIdentity = await lstat(path);
    const prepared = await mutation(path, "candidate source\n", projectRoot);
    const moveParent = async () => {
      await rename(preparedParent, displacedParent);
      await symlink(displacedParent, preparedParent, "dir");
    };

    const result = await applyIOSExistingFileTransaction(
      [prepared],
      [async () => true],
      hook === "afterExistingDestinationClaim"
        ? { afterExistingDestinationClaim: moveParent }
        : { beforeExistingDestinationInstall: moveParent },
    );

    expect(result).toEqual({ status: "stale" });
    expect(await readFile(path, "utf8")).toBe("original source\n");
    expect(await readFile(join(displacedParent, "App.swift"), "utf8")).toBe("original source\n");
    const restoredIdentity = await lstat(path);
    expect(restoredIdentity.ino).toBe(originalIdentity.ino);
    expect(restoredIdentity.mode & 0o7777).toBe(0o640);
    await expectNoTemporaryFiles(displacedParent);
  });

  test("fails explicitly rather than clobbering a newer file when a claimed original cannot be restored", async () => {
    const root = await temporaryRoot();
    const projectRoot = join(root, "project");
    const preparedParent = join(projectRoot, "Sources");
    const outsideRoot = join(root, "outside");
    const displacedParent = join(outsideRoot, "Sources");
    const path = join(preparedParent, "App.swift");
    await mkdir(preparedParent, { recursive: true });
    await mkdir(outsideRoot);
    await writeFile(path, "original source\n");
    const prepared = await mutation(path, "candidate source\n", projectRoot);

    let caught: unknown;
    try {
      await applyIOSExistingFileTransaction([prepared], [async () => true], {
        afterExistingDestinationClaim: async () => {
          await rename(preparedParent, displacedParent);
          await symlink(displacedParent, preparedParent, "dir");
          await writeFile(path, "newer editor source\n");
        },
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(IOSFileTransactionError);
    expect((caught as IOSFileTransactionError).code).toBe("commit-failed");
    expect(errorText(caught)).toContain("a claimed original could not be restored");
    expect(await readFile(path, "utf8")).toBe("newer editor source\n");
    await expectRecoverableClaimedOriginals(displacedParent, ["original source\n"]);
  });

  test("rejects an ancestor symlink even when the prepared parent inode still matches", async () => {
    const root = await temporaryRoot();
    const projectRoot = join(root, "project");
    const preparedAncestor = join(projectRoot, "App");
    const preparedParent = join(preparedAncestor, "Sources");
    const outsideRoot = join(root, "outside");
    const displacedAncestor = join(outsideRoot, "App");
    const path = join(preparedParent, "App.swift");
    await mkdir(preparedParent, { recursive: true });
    await mkdir(outsideRoot);
    await writeFile(path, "original source\n");
    const prepared = await mutation(path, "candidate source\n", projectRoot);
    const preparedParentIdentity = await lstat(preparedParent);

    await rename(preparedAncestor, displacedAncestor);
    await symlink(displacedAncestor, preparedAncestor, "dir");
    const redirectedParentIdentity = await lstat(preparedParent);
    expect(redirectedParentIdentity.dev).toBe(preparedParentIdentity.dev);
    expect(redirectedParentIdentity.ino).toBe(preparedParentIdentity.ino);

    const result = await applyIOSExistingFileTransaction([prepared], [async () => true]);

    expect(result).toEqual({ status: "stale" });
    expect(await readFile(join(displacedAncestor, "Sources", "App.swift"), "utf8")).toBe(
      "original source\n",
    );
    await expectNoTemporaryFiles(join(displacedAncestor, "Sources"));
  });

  test("stages and commits every file sequentially while preserving modes", async () => {
    const root = await temporaryRoot();
    const firstPath = join(root, "project.pbxproj");
    const secondPath = join(root, "App.swift");
    await writeFile(firstPath, "original project\n");
    await writeFile(secondPath, "original source\n");
    await chmod(firstPath, 0o640);
    await chmod(secondPath, 0o600);
    const mutations = await Promise.all([
      mutation(firstPath, "candidate project\n"),
      mutation(secondPath, "candidate source\n"),
    ]);
    let firstValidated = false;
    let secondValidated = false;

    const result = await applyIOSExistingFileTransaction(mutations, [
      async () => {
        await Promise.resolve();
        firstValidated = true;
        return (await readFile(firstPath, "utf8")) === "candidate project\n";
      },
      async () => {
        await Promise.resolve();
        secondValidated = true;
        return (await readFile(secondPath, "utf8")) === "candidate source\n";
      },
    ]);

    expect(result).toEqual({ status: "applied" });
    expect(firstValidated).toBe(true);
    expect(secondValidated).toBe(true);
    expect(await readFile(firstPath, "utf8")).toBe("candidate project\n");
    expect(await readFile(secondPath, "utf8")).toBe("candidate source\n");
    expect((await lstat(firstPath)).mode & 0o7777).toBe(0o640);
    expect((await lstat(secondPath)).mode & 0o7777).toBe(0o600);
    await expectNoTemporaryFiles(root);
  });

  test("keeps both inodes recoverable across the exclusive install boundary", async () => {
    const root = await temporaryRoot();
    const path = join(root, "App.swift");
    await writeFile(path, "original source\n");
    const prepared = await mutation(path, "candidate source\n");
    let claimPath: string | undefined;
    const observed: string[] = [];

    const result = await applyIOSExistingFileTransaction([prepared], [async () => true], {
      beforeExistingDestinationClaim: async (destinationPath) => {
        expect(await readFile(destinationPath, "utf8")).toBe("original source\n");
        observed.push("before-claim");
      },
      afterExistingDestinationClaim: async (destinationPath, createdClaimPath) => {
        claimPath = createdClaimPath;
        await expect(lstat(destinationPath)).rejects.toMatchObject({ code: "ENOENT" });
        expect(await readFile(createdClaimPath, "utf8")).toBe("original source\n");
        const stagedPath = (await readdir(root)).find((name) => name.endsWith(".tmp"));
        if (!stagedPath) throw new Error("expected the staged candidate to remain recoverable");
        expect(await readFile(join(root, stagedPath), "utf8")).toBe("candidate source\n");
        observed.push("original-claimed");
      },
      beforeExistingDestinationInstall: async (destinationPath, createdClaimPath) => {
        await expect(lstat(destinationPath)).rejects.toMatchObject({ code: "ENOENT" });
        expect(await readFile(createdClaimPath, "utf8")).toBe("original source\n");
        observed.push("before-exclusive-install");
      },
      afterExistingDestinationInstall: async (destinationPath, createdClaimPath) => {
        expect(await readFile(destinationPath, "utf8")).toBe("candidate source\n");
        expect(await readFile(createdClaimPath, "utf8")).toBe("original source\n");
        const stagedPath = (await readdir(root)).find((name) => name.endsWith(".tmp"));
        if (!stagedPath) throw new Error("expected the candidate recovery link to remain");
        expect((await lstat(join(root, stagedPath))).ino).toBe((await lstat(destinationPath)).ino);
        observed.push("candidate-and-original-recoverable");
      },
    });

    expect(result).toEqual({ status: "applied" });
    expect(observed).toEqual([
      "before-claim",
      "original-claimed",
      "before-exclusive-install",
      "candidate-and-original-recoverable",
    ]);
    expect(claimPath).toBeDefined();
    await expect(lstat(claimPath!)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(path, "utf8")).toBe("candidate source\n");
    await expectNoTemporaryFiles(root);
  });

  test("restores the verified original through an exclusive rollback install", async () => {
    const root = await temporaryRoot();
    const path = join(root, "App.swift");
    await writeFile(path, "original source\n");
    const prepared = await mutation(path, "candidate source\n");
    let originalClaimPath: string | undefined;
    let candidateClaimPath: string | undefined;

    const result = await applyIOSExistingFileTransaction([prepared], [async () => false], {
      afterExistingDestinationClaim: (_destinationPath, createdClaimPath) => {
        originalClaimPath = createdClaimPath;
      },
      beforeRollbackDestinationClaim: async (destinationPath) => {
        expect(await readFile(destinationPath, "utf8")).toBe("candidate source\n");
      },
      afterRollbackDestinationClaim: async (destinationPath, createdClaimPath) => {
        candidateClaimPath = createdClaimPath;
        await expect(lstat(destinationPath)).rejects.toMatchObject({ code: "ENOENT" });
        expect(await readFile(createdClaimPath, "utf8")).toBe("candidate source\n");
      },
      beforeRollbackDestinationInstall: async (
        destinationPath,
        originalSourcePath,
        createdCandidateClaimPath,
      ) => {
        await expect(lstat(destinationPath)).rejects.toMatchObject({ code: "ENOENT" });
        expect(originalClaimPath).toBe(originalSourcePath);
        expect(candidateClaimPath).toBe(createdCandidateClaimPath);
        expect(await readFile(originalSourcePath, "utf8")).toBe("original source\n");
      },
      afterRollbackDestinationInstall: async (destinationPath) => {
        expect(await readFile(destinationPath, "utf8")).toBe("original source\n");
        expect(originalClaimPath).toBeDefined();
        expect(candidateClaimPath).toBeDefined();
        expect(await readFile(originalClaimPath!, "utf8")).toBe("original source\n");
        expect(await readFile(candidateClaimPath!, "utf8")).toBe("candidate source\n");
      },
    });

    expect(result).toEqual({ status: "rolled-back" });
    expect(await readFile(path, "utf8")).toBe("original source\n");
    await expect(lstat(originalClaimPath!)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(lstat(candidateClaimPath!)).rejects.toMatchObject({ code: "ENOENT" });
    await expectNoTemporaryFiles(root);
  });

  test("rolls back an after-install failure without exposing candidate source bytes", async () => {
    const root = await temporaryRoot();
    const path = join(root, "App.swift");
    const sensitiveCandidate = "pk_test_candidate_must_not_escape";
    await writeFile(path, "original source\n");
    const prepared = await mutation(path, sensitiveCandidate);

    let caught: unknown;
    try {
      await applyIOSExistingFileTransaction([prepared], [async () => true], {
        afterExistingDestinationInstall: () => {
          throw new Error("forced after-install failure");
        },
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(IOSFileTransactionError);
    expect((caught as IOSFileTransactionError).code).toBe("commit-failed");
    expect(errorText(caught)).not.toContain(sensitiveCandidate);
    expect(await readFile(path, "utf8")).toBe("original source\n");
    await expectNoTemporaryFiles(root);
  });

  test("runs every postcondition and rolls back every file byte-for-byte", async () => {
    const root = await temporaryRoot();
    const firstPath = join(root, "project.pbxproj");
    const secondPath = join(root, "App.swift");
    const originalProject = new Uint8Array([0, 1, 2, 255]);
    const originalSource = new TextEncoder().encode("// original\r\n");
    await writeFile(firstPath, originalProject);
    await writeFile(secondPath, originalSource);
    const sensitiveCandidate = "pk_test_candidate_must_not_escape";
    const mutations = await Promise.all([
      mutation(firstPath, `candidate ${sensitiveCandidate}`),
      mutation(secondPath, `candidate ${sensitiveCandidate}`),
    ]);
    let throwingValidatorRan = false;
    let falseValidatorRan = false;

    const result = await applyIOSExistingFileTransaction(mutations, [
      async () => {
        throwingValidatorRan = true;
        throw new Error(sensitiveCandidate);
      },
      async () => {
        falseValidatorRan = true;
        return false;
      },
    ]);

    expect(result).toEqual({ status: "rolled-back" });
    expect(JSON.stringify(result)).not.toContain(sensitiveCandidate);
    expect(throwingValidatorRan).toBe(true);
    expect(falseValidatorRan).toBe(true);
    expect(new Uint8Array(await readFile(firstPath))).toEqual(originalProject);
    expect(new Uint8Array(await readFile(secondPath))).toEqual(originalSource);
    await expectNoTemporaryFiles(root);
  });

  test("rejects a candidate edit after an earlier postcondition validates it", async () => {
    const root = await temporaryRoot();
    const path = join(root, "App.swift");
    await writeFile(path, "original source\n");
    const prepared = await mutation(path, "candidate source\n");
    let releaseValidated: (() => void) | undefined;
    const validated = new Promise<void>((resolve) => {
      releaseValidated = resolve;
    });

    let caught: unknown;
    try {
      await applyIOSExistingFileTransaction(
        [prepared],
        [
          async () => {
            const matches = (await readFile(path, "utf8")) === "candidate source\n";
            releaseValidated?.();
            return matches;
          },
          async () => {
            await validated;
            await writeFile(path, "newer user source\n");
            return true;
          },
        ],
      );
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(IOSFileTransactionError);
    expect((caught as IOSFileTransactionError).code).toBe("rollback-failed");
    expect(await readFile(path, "utf8")).toBe("newer user source\n");
    await expectRecoverableClaimedOriginals(root, ["original source\n"]);
  });

  test("cleans every staged candidate and preserves newer bytes when stale", async () => {
    const root = await temporaryRoot();
    const firstPath = join(root, "project.pbxproj");
    const secondPath = join(root, "App.swift");
    await writeFile(firstPath, "original project\n");
    await writeFile(secondPath, "original source\n");
    const mutations = await Promise.all([
      mutation(firstPath, "candidate project\n"),
      mutation(secondPath, "candidate source\n"),
    ]);
    await writeFile(firstPath, "newer user project\n");

    const result = await applyIOSExistingFileTransaction(mutations, [async () => true]);

    expect(result).toEqual({ status: "stale" });
    expect(await readFile(firstPath, "utf8")).toBe("newer user project\n");
    expect(await readFile(secondPath, "utf8")).toBe("original source\n");
    await expectNoTemporaryFiles(root);
  });

  test("returns stale when the original mode changed after preparation", async () => {
    const root = await temporaryRoot();
    const path = join(root, "App.swift");
    await writeFile(path, "original\n");
    await chmod(path, 0o640);
    const prepared = await mutation(path, "candidate\n");
    await chmod(path, 0o600);

    const result = await applyIOSExistingFileTransaction([prepared], [async () => true]);

    expect(result).toEqual({ status: "stale" });
    expect(await readFile(path, "utf8")).toBe("original\n");
    expect((await lstat(path)).mode & 0o7777).toBe(0o600);
    await expectNoTemporaryFiles(root);
  });

  test("returns stale when the original mode changes during staging", async () => {
    const root = await temporaryRoot();
    const path = join(root, "App.swift");
    await writeFile(path, "original\n");
    await chmod(path, 0o640);
    const prepared = await mutation(path, "x".repeat(16 * 1024 * 1024));
    const changeMode = (async () => {
      await waitForStagingFile(root);
      await chmod(path, 0o600);
    })();

    const [result] = await Promise.all([
      applyIOSExistingFileTransaction([prepared], [async () => true]),
      changeMode,
    ]);

    expect(result).toEqual({ status: "stale" });
    expect(await readFile(path, "utf8")).toBe("original\n");
    expect((await lstat(path)).mode & 0o7777).toBe(0o600);
    await expectNoTemporaryFiles(root);
  });

  test("returns stale when a same-byte file replaces the original during staging", async () => {
    const root = await temporaryRoot();
    const path = join(root, "App.swift");
    const replacementPath = join(root, "external-replacement.tmp");
    await writeFile(path, "original\n");
    await chmod(path, 0o640);
    const prepared = await mutation(path, "x".repeat(16 * 1024 * 1024));
    await writeFile(replacementPath, "original\n");
    await chmod(replacementPath, 0o640);
    const replacementIdentity = await lstat(replacementPath);
    const replaceOriginal = (async () => {
      await waitForStagingFile(root);
      await rename(replacementPath, path);
    })();

    const [result] = await Promise.all([
      applyIOSExistingFileTransaction([prepared], [async () => true]),
      replaceOriginal,
    ]);

    expect(result).toEqual({ status: "stale" });
    expect(await readFile(path, "utf8")).toBe("original\n");
    expect((await lstat(path)).ino).toBe(replacementIdentity.ino);
    await expectNoTemporaryFiles(root);
  });

  test("rechecks identity immediately before each replacement commit", async () => {
    const root = await temporaryRoot();
    const firstPath = join(root, "First.swift");
    const targetPath = join(root, "Target.swift");
    const replacementPath = join(root, "external-target.tmp");
    await writeFile(firstPath, "original first\n");
    await writeFile(targetPath, "original target\n");
    await chmod(targetPath, 0o640);
    const intermediatePaths = Array.from({ length: 20 }, (_, index) =>
      join(root, `Intermediate-${index}.swift`),
    );
    await Promise.all(intermediatePaths.map((path) => writeFile(path, "original middle\n")));
    await writeFile(replacementPath, "original target\n");
    await chmod(replacementPath, 0o640);
    const replacementIdentity = await lstat(replacementPath);
    const prepared = await Promise.all([
      mutation(firstPath, "candidate first\n"),
      ...intermediatePaths.map((path) => mutation(path, "candidate middle\n")),
      mutation(targetPath, "candidate target\n"),
    ]);
    const replaceTarget = (async () => {
      await waitForCondition(async () => {
        try {
          return (await readFile(firstPath, "utf8")) === "candidate first\n";
        } catch {
          return false;
        }
      });
      await rename(replacementPath, targetPath);
    })();

    const [result] = await Promise.all([
      applyIOSExistingFileTransaction(prepared, [async () => true]),
      replaceTarget,
    ]);

    expect(result).toEqual({ status: "stale" });
    expect(await readFile(firstPath, "utf8")).toBe("original first\n");
    for (const path of intermediatePaths) {
      expect(await readFile(path, "utf8")).toBe("original middle\n");
    }
    expect(await readFile(targetPath, "utf8")).toBe("original target\n");
    expect((await lstat(targetPath)).ino).toBe(replacementIdentity.ino);
    await expectNoTemporaryFiles(root);
  });

  test("preserves an editor replacement that wins the commit install boundary", async () => {
    const root = await temporaryRoot();
    const path = join(root, "App.swift");
    const replacementPath = join(root, "external-replacement.tmp");
    await writeFile(path, "original\n");
    await chmod(path, 0o640);
    const prepared = await mutation(path, "candidate\n");
    await writeFile(replacementPath, "newer user source\n");
    await chmod(replacementPath, 0o600);
    const replacementIdentity = await lstat(replacementPath);

    const result = await applyIOSExistingFileTransaction([prepared], [async () => true], {
      beforeExistingDestinationInstall: async (destinationPath) => {
        await rename(replacementPath, destinationPath);
      },
    });

    expect(result).toEqual({ status: "stale" });
    expect(await readFile(path, "utf8")).toBe("newer user source\n");
    expect((await lstat(path)).ino).toBe(replacementIdentity.ino);
    expect((await lstat(path)).mode & 0o7777).toBe(0o600);
    await expectNoTemporaryFiles(root);
  });

  test("rolls back earlier files when an editor wins a later install boundary", async () => {
    const root = await temporaryRoot();
    const firstPath = join(root, "First.swift");
    const secondPath = join(root, "Second.swift");
    const replacementPath = join(root, "external-second.tmp");
    await writeFile(firstPath, "original first\n");
    await writeFile(secondPath, "original second\n");
    await chmod(secondPath, 0o640);
    await writeFile(replacementPath, "newer editor second\n");
    await chmod(replacementPath, 0o600);
    const replacementIdentity = await lstat(replacementPath);
    const prepared = await Promise.all([
      mutation(firstPath, "candidate first\n"),
      mutation(secondPath, "candidate second\n"),
    ]);

    const result = await applyIOSExistingFileTransaction(prepared, [async () => true], {
      beforeExistingDestinationInstall: async (destinationPath) => {
        if (destinationPath === secondPath) await rename(replacementPath, destinationPath);
      },
    });

    expect(result).toEqual({ status: "stale" });
    expect(await readFile(firstPath, "utf8")).toBe("original first\n");
    expect(await readFile(secondPath, "utf8")).toBe("newer editor second\n");
    expect((await lstat(secondPath)).ino).toBe(replacementIdentity.ino);
    expect((await lstat(secondPath)).mode & 0o7777).toBe(0o600);
    await expectNoTemporaryFiles(root);
  });

  test("preserves writes through an already-open original file descriptor", async () => {
    const root = await temporaryRoot();
    const path = join(root, "App.swift");
    await writeFile(path, "original\n");
    await chmod(path, 0o640);
    const prepared = await mutation(path, "candidate\n");
    const editor = await open(path, "r+");

    let result;
    try {
      result = await applyIOSExistingFileTransaction(
        [prepared],
        [
          async () => {
            await editor.truncate(0);
            await editor.write("newer user source through open fd\n", 0, "utf8");
            await editor.chmod(0o600);
            await editor.sync();
            return true;
          },
        ],
      );
    } finally {
      await editor.close();
    }

    expect(result).toEqual({ status: "stale" });
    expect(await readFile(path, "utf8")).toBe("newer user source through open fd\n");
    expect((await lstat(path)).mode & 0o7777).toBe(0o600);
    await expectNoTemporaryFiles(root);
  });

  test("guards rollback with candidate hashes and reports an explicit failure", async () => {
    const root = await temporaryRoot();
    const firstPath = join(root, "project.pbxproj");
    const secondPath = join(root, "App.swift");
    await writeFile(firstPath, "original project\n");
    await writeFile(secondPath, "original source\n");
    const sensitiveCandidate = "pk_test_candidate_must_not_escape";
    const mutations = await Promise.all([
      mutation(firstPath, `candidate project ${sensitiveCandidate}\n`),
      mutation(secondPath, `candidate source ${sensitiveCandidate}\n`),
    ]);

    let caught: unknown;
    try {
      await applyIOSExistingFileTransaction(mutations, [
        async () => {
          await writeFile(secondPath, "newer user source\n");
          return false;
        },
      ]);
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(IOSFileTransactionError);
    expect((caught as IOSFileTransactionError).code).toBe("rollback-failed");
    expect(errorText(caught)).not.toContain(sensitiveCandidate);
    expect(await readFile(firstPath, "utf8")).toBe(`candidate project ${sensitiveCandidate}\n`);
    expect(await readFile(secondPath, "utf8")).toBe("newer user source\n");
    await expectRecoverableClaimedOriginals(root, ["original project\n", "original source\n"]);
  });

  test("preserves a candidate whose mode changed before rollback", async () => {
    const root = await temporaryRoot();
    const path = join(root, "App.swift");
    await writeFile(path, "original\n");
    await chmod(path, 0o640);
    const prepared = await mutation(path, "candidate\n");

    let caught: unknown;
    try {
      await applyIOSExistingFileTransaction(
        [prepared],
        [
          async () => {
            await chmod(path, 0o600);
            return false;
          },
        ],
      );
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(IOSFileTransactionError);
    expect((caught as IOSFileTransactionError).code).toBe("rollback-failed");
    expect(await readFile(path, "utf8")).toBe("candidate\n");
    expect((await lstat(path)).mode & 0o7777).toBe(0o600);
    await expectRecoverableClaimedOriginals(root, ["original\n"]);
  });

  test("preserves a same-byte file that replaced the committed candidate inode", async () => {
    const root = await temporaryRoot();
    const path = join(root, "App.swift");
    const replacementPath = join(root, "external-replacement.tmp");
    await writeFile(path, "original\n");
    await chmod(path, 0o640);
    const prepared = await mutation(path, "candidate\n");

    let caught: unknown;
    try {
      await applyIOSExistingFileTransaction(
        [prepared],
        [
          async () => {
            await writeFile(replacementPath, "candidate\n");
            await chmod(replacementPath, 0o640);
            await rename(replacementPath, path);
            return false;
          },
        ],
      );
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(IOSFileTransactionError);
    expect((caught as IOSFileTransactionError).code).toBe("rollback-failed");
    expect(await readFile(path, "utf8")).toBe("candidate\n");
    expect((await lstat(path)).mode & 0o7777).toBe(0o640);
    await expectRecoverableClaimedOriginals(root, ["original\n"]);
  });

  test("preserves an editor replacement that wins the rollback install boundary", async () => {
    const root = await temporaryRoot();
    const path = join(root, "App.swift");
    const replacementPath = join(root, "external-replacement.tmp");
    await writeFile(path, "original\n");
    await chmod(path, 0o640);
    const prepared = await mutation(path, "candidate\n");
    await writeFile(replacementPath, "newer user source\n");
    await chmod(replacementPath, 0o600);
    const replacementIdentity = await lstat(replacementPath);

    let caught: unknown;
    try {
      await applyIOSExistingFileTransaction([prepared], [async () => false], {
        beforeRollbackDestinationInstall: async (destinationPath) => {
          await rename(replacementPath, destinationPath);
        },
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(IOSFileTransactionError);
    expect((caught as IOSFileTransactionError).code).toBe("rollback-failed");
    expect(await readFile(path, "utf8")).toBe("newer user source\n");
    expect((await lstat(path)).ino).toBe(replacementIdentity.ino);
    expect((await lstat(path)).mode & 0o7777).toBe(0o600);
    await expectRecoverableClaimedOriginals(root, ["original\n"]);
  });

  test("rejects invalid prepared hashes without exposing candidate bytes", async () => {
    const root = await temporaryRoot();
    const path = join(root, "App.swift");
    await writeFile(path, "original\n");
    const prepared = await mutation(path, "pk_test_candidate_must_not_escape");
    prepared.candidateHash = hashIOSFileBytes("different bytes");

    let caught: unknown;
    try {
      await applyIOSExistingFileTransaction([prepared], []);
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(IOSFileTransactionError);
    expect((caught as IOSFileTransactionError).code).toBe("invalid-mutation");
    expect(errorText(caught)).not.toContain("pk_test_candidate_must_not_escape");
    expect(await readFile(path, "utf8")).toBe("original\n");
    await expectNoTemporaryFiles(root);
  });
});

describe("iOS create-file transaction", () => {
  test("returns stale when the prepared parent directory was replaced", async () => {
    const root = await temporaryRoot();
    const synchronizedRoot = join(root, "CoolApp");
    const displacedRoot = join(root, "CoolApp-before-replacement");
    const createdPath = join(synchronizedRoot, "CoolApp.entitlements");
    await mkdir(synchronizedRoot);
    const prepared = await createMutation(createdPath, "candidate entitlements\n");
    await rename(synchronizedRoot, displacedRoot);
    await mkdir(synchronizedRoot);

    const result = await applyIOSFileTransaction([prepared], [async () => true]);

    expect(result).toEqual({ status: "stale" });
    await expect(lstat(createdPath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(lstat(join(displacedRoot, "CoolApp.entitlements"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expectNoTemporaryFiles(synchronizedRoot);
    await expectNoTemporaryFiles(displacedRoot);
  });

  test("fails closed when the prepared parent identity changes after create staging", async () => {
    const root = await temporaryRoot();
    const synchronizedRoot = join(root, "CoolApp");
    const displacedRoot = join(root, "CoolApp-before-replacement");
    const createdPath = join(synchronizedRoot, "CoolApp.entitlements");
    const sourcePath = join(root, "CoolApp.swift");
    await mkdir(synchronizedRoot);
    await writeFile(sourcePath, "original source\n");
    const prepared = [
      await createMutation(createdPath, "candidate entitlements\n"),
      await mutation(sourcePath, "x".repeat(16 * 1024 * 1024)),
    ];
    const replaceParentAfterCreateStage = (async () => {
      await waitForStagingFile(root);
      await rename(synchronizedRoot, displacedRoot);
      await symlink(displacedRoot, synchronizedRoot, "dir");
    })();

    const [result] = await Promise.all([
      applyIOSFileTransaction(prepared, [async () => true]),
      replaceParentAfterCreateStage,
    ]);

    expect(result).toEqual({ status: "stale" });
    expect(await readFile(sourcePath, "utf8")).toBe("original source\n");
    await expect(lstat(createdPath)).rejects.toMatchObject({ code: "ENOENT" });
    await expectNoTemporaryFiles(displacedRoot);
    await expectNoTemporaryFiles(root);
  });

  test("restores an existing file when a create parent moves after its candidate is linked", async () => {
    const root = await temporaryRoot();
    const synchronizedRoot = join(root, "CoolApp");
    const displacedRoot = join(root, "CoolApp-before-replacement");
    const createdPath = join(synchronizedRoot, "CoolApp.entitlements");
    const projectPath = join(root, "project.pbxproj");
    const concurrentPath = join(synchronizedRoot, "concurrent-user-file");
    await mkdir(synchronizedRoot);
    await writeFile(concurrentPath, "newer directory state\n");
    await writeFile(projectPath, "original project\n");
    const prepared = [
      await mutation(projectPath, "candidate project\n"),
      await createMutation(createdPath, "candidate entitlements\n"),
    ];

    let caught: unknown;
    try {
      await applyIOSFileTransaction(prepared, [async () => true], {
        beforeExistingDestinationInstall: async () => {
          await rename(synchronizedRoot, displacedRoot);
          await mkdir(synchronizedRoot);
        },
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(IOSFileTransactionError);
    expect((caught as IOSFileTransactionError).code).toBe("rollback-failed");
    expect(await readFile(projectPath, "utf8")).toBe("original project\n");
    await expect(lstat(createdPath)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(join(displacedRoot, "concurrent-user-file"), "utf8")).toBe(
      "newer directory state\n",
    );
  });

  test("restores a committed project file if the create parent changes during postvalidation", async () => {
    const root = await temporaryRoot();
    const synchronizedRoot = join(root, "CoolApp");
    const displacedRoot = join(root, "CoolApp-before-replacement");
    const createdPath = join(synchronizedRoot, "CoolApp.entitlements");
    const projectPath = join(root, "project.pbxproj");
    await mkdir(synchronizedRoot);
    await writeFile(projectPath, "original project\n");
    const sensitiveCandidate = "pk_test_candidate_must_not_escape";
    const prepared = [
      await createMutation(createdPath, sensitiveCandidate),
      await mutation(projectPath, "candidate project\n"),
    ];

    let caught: unknown;
    try {
      await applyIOSFileTransaction(prepared, [
        async () => {
          await rename(synchronizedRoot, displacedRoot);
          await mkdir(synchronizedRoot);
          return true;
        },
      ]);
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(IOSFileTransactionError);
    expect((caught as IOSFileTransactionError).code).toBe("rollback-failed");
    expect(errorText(caught)).not.toContain(sensitiveCandidate);
    expect(await readFile(projectPath, "utf8")).toBe("original project\n");
    await expect(lstat(createdPath)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(join(displacedRoot, "CoolApp.entitlements"), "utf8")).toBe(
      sensitiveCandidate,
    );
  });

  test("creates an absent file alongside a replacement and preserves both modes", async () => {
    const root = await temporaryRoot();
    const existingPath = join(root, "project.pbxproj");
    const createdPath = join(root, "CoolApp.entitlements");
    await writeFile(existingPath, "original project\n");
    await chmod(existingPath, 0o600);

    const result = await applyIOSFileTransaction(
      [
        await createMutation(createdPath, "created entitlements\n", 0o640),
        await mutation(existingPath, "candidate project\n"),
      ],
      [
        async () => (await readFile(createdPath, "utf8")) === "created entitlements\n",
        async () => (await readFile(existingPath, "utf8")) === "candidate project\n",
      ],
    );

    expect(result).toEqual({ status: "applied" });
    expect(await readFile(createdPath, "utf8")).toBe("created entitlements\n");
    expect(await readFile(existingPath, "utf8")).toBe("candidate project\n");
    expect((await lstat(createdPath)).mode & 0o7777).toBe(0o640);
    expect((await lstat(createdPath)).nlink).toBe(1);
    expect((await lstat(existingPath)).mode & 0o7777).toBe(0o600);
    await expectNoTemporaryFiles(root);
  });

  test("treats a formerly absent path as stale without clobbering it", async () => {
    const root = await temporaryRoot();
    const existingPath = join(root, "project.pbxproj");
    const createdPath = join(root, "CoolApp.entitlements");
    await writeFile(existingPath, "original project\n");
    const mutations = [
      await mutation(existingPath, "candidate project\n"),
      await createMutation(createdPath, "candidate entitlements\n"),
    ];
    await writeFile(createdPath, "newer user entitlements\n");

    const result = await applyIOSFileTransaction(mutations, [async () => true]);

    expect(result).toEqual({ status: "stale" });
    expect(await readFile(existingPath, "utf8")).toBe("original project\n");
    expect(await readFile(createdPath, "utf8")).toBe("newer user entitlements\n");
    await expectNoTemporaryFiles(root);
  });

  test("removes a created file and restores replacements when validation fails", async () => {
    const root = await temporaryRoot();
    const existingPath = join(root, "project.pbxproj");
    const createdPath = join(root, "CoolApp.entitlements");
    await writeFile(existingPath, "original project\n");

    const result = await applyIOSFileTransaction(
      [
        await mutation(existingPath, "candidate project\n"),
        await createMutation(createdPath, "candidate entitlements\n"),
      ],
      [async () => false],
    );

    expect(result).toEqual({ status: "rolled-back" });
    expect(await readFile(existingPath, "utf8")).toBe("original project\n");
    await expect(lstat(createdPath)).rejects.toMatchObject({ code: "ENOENT" });
    await expectNoTemporaryFiles(root);
  });

  test("preserves newer bytes at a created path when rollback is requested", async () => {
    const root = await temporaryRoot();
    const createdPath = join(root, "CoolApp.entitlements");
    const sensitiveCandidate = "pk_test_candidate_must_not_escape";

    let caught: unknown;
    try {
      await applyIOSFileTransaction(
        [await createMutation(createdPath, sensitiveCandidate)],
        [
          async () => {
            await writeFile(createdPath, "newer user entitlements\n");
            return false;
          },
        ],
      );
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(IOSFileTransactionError);
    expect((caught as IOSFileTransactionError).code).toBe("rollback-failed");
    expect(errorText(caught)).not.toContain(sensitiveCandidate);
    expect(await readFile(createdPath, "utf8")).toBe("newer user entitlements\n");
    await expectNoTemporaryFiles(root);
  });

  test("preserves a same-byte file that replaced the transaction's created inode", async () => {
    const root = await temporaryRoot();
    const createdPath = join(root, "CoolApp.entitlements");
    const candidate = "candidate entitlements\n";

    let caught: unknown;
    try {
      await applyIOSFileTransaction(
        [await createMutation(createdPath, candidate)],
        [
          async () => {
            await rm(createdPath);
            await writeFile(createdPath, candidate);
            return false;
          },
        ],
      );
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(IOSFileTransactionError);
    expect((caught as IOSFileTransactionError).code).toBe("rollback-failed");
    expect(await readFile(createdPath, "utf8")).toBe(candidate);
    await expectNoTemporaryFiles(root);
  });

  test("rejects an invalid create hash without exposing candidate bytes", async () => {
    const root = await temporaryRoot();
    const createdPath = join(root, "CoolApp.entitlements");
    const sensitiveCandidate = "pk_test_candidate_must_not_escape";
    const prepared = await createMutation(createdPath, sensitiveCandidate);
    prepared.candidateHash = hashIOSFileBytes("different bytes");

    let caught: unknown;
    try {
      await applyIOSFileTransaction([prepared], []);
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(IOSFileTransactionError);
    expect((caught as IOSFileTransactionError).code).toBe("invalid-mutation");
    expect(errorText(caught)).not.toContain(sensitiveCandidate);
    await expect(lstat(createdPath)).rejects.toMatchObject({ code: "ENOENT" });
    await expectNoTemporaryFiles(root);
  });
});

describe("iOS file transaction crash recovery", () => {
  test("does not touch the project root when no interrupted transaction exists", async () => {
    const root = await temporaryRoot();
    const before = await lstat(root, { bigint: true });

    await recoverIOSFileTransactions(root);

    const after = await lstat(root, { bigint: true });
    expect(after.mtimeNs).toBe(before.mtimeNs);
    expect(await readdir(root)).toEqual([]);
  });

  test("never publishes a partial root lock when SIGKILL interrupts publication", async () => {
    const root = await temporaryRoot();
    const path = join(root, "App.swift");
    await writeFile(path, "original source\n");

    const lockPath = await crashFileTransaction(root, [path], "lock-publication");

    expect(lockPath).toBeDefined();
    await expect(lstat(lockPath!)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(path, "utf8")).toBe("original source\n");
    const prepared = await mutation(path, "candidate source\n", root);
    expect(await applyIOSExistingFileTransaction([prepared], [async () => true])).toEqual({
      status: "applied",
    });
  }, 15_000);

  test("never publishes a partial initial journal when SIGKILL interrupts publication", async () => {
    const root = await temporaryRoot();
    const path = join(root, "App.swift");
    await writeFile(path, "original source\n");

    const journalPath = await crashFileTransaction(root, [path], "journal-publication");

    expect(journalPath).toBeDefined();
    await expect(lstat(journalPath!)).rejects.toMatchObject({ code: "ENOENT" });
    await recoverIOSFileTransactions(root);
    expect(await readFile(path, "utf8")).toBe("original source\n");
    const prepared = await mutation(path, "candidate source\n", root);
    expect(await applyIOSExistingFileTransaction([prepared], [async () => true])).toEqual({
      status: "applied",
    });
  }, 15_000);

  test("does not write through a project root redirected after initial journal publication", async () => {
    const base = await temporaryRoot();
    const root = join(base, "project");
    const displacedRoot = join(base, "project-original");
    const outsideRoot = join(base, "outside");
    const path = join(root, "App.swift");
    await mkdir(root);
    await mkdir(outsideRoot);
    await writeFile(path, "original source\n");
    await writeFile(join(outsideRoot, "sentinel"), "outside bytes\n");
    const prepared = await mutation(path, "candidate source\n", root);
    let outsideJournalPath = "";
    let outsideMtime: bigint | undefined;
    let outsideEntries: string[] = [];

    let caught: unknown;
    try {
      await applyIOSExistingFileTransaction([prepared], [async () => true], {
        beforeRecoveryJournalPublication: async (journalPath) => {
          outsideJournalPath = join(outsideRoot, basename(journalPath));
          await writeFile(outsideJournalPath, "outside journal bytes\n");
        },
        afterInitialRecoveryJournalPublication: async () => {
          await rename(root, displacedRoot);
          await symlink(outsideRoot, root, "dir");
          outsideMtime = (await lstat(outsideRoot, { bigint: true })).mtimeNs;
          outsideEntries = (await readdir(outsideRoot)).sort();
        },
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(IOSFileTransactionError);
    expect((caught as IOSFileTransactionError).code).toBe("stage-failed");
    expect(outsideMtime).toBeDefined();
    const outsideAfter = await lstat(outsideRoot, { bigint: true });
    expect(outsideAfter.mtimeNs).toBe(outsideMtime!);
    expect((await readdir(outsideRoot)).sort()).toEqual(outsideEntries);
    expect(await readFile(outsideJournalPath, "utf8")).toBe("outside journal bytes\n");
    expect(await readFile(join(outsideRoot, "sentinel"), "utf8")).toBe("outside bytes\n");
    expect(await readFile(join(displacedRoot, "App.swift"), "utf8")).toBe("original source\n");
    expect((await readdir(displacedRoot)).some((name) => name.endsWith(".journal"))).toBe(true);
  });

  test("does not write through a project root redirected before lock publication", async () => {
    const base = await temporaryRoot();
    const root = join(base, "project");
    const displacedRoot = join(base, "project-original");
    const outsideRoot = join(base, "outside");
    const path = join(root, "App.swift");
    await mkdir(root);
    await mkdir(outsideRoot);
    await writeFile(path, "original source\n");
    await writeFile(join(outsideRoot, "sentinel"), "outside bytes\n");
    const prepared = await mutation(path, "candidate source\n", root);
    const outsideBefore = await lstat(outsideRoot, { bigint: true });

    const result = await applyIOSExistingFileTransaction([prepared], [async () => true], {
      beforeRootLockPublication: async () => {
        await rename(root, displacedRoot);
        await symlink(outsideRoot, root, "dir");
      },
    });

    const outsideAfter = await lstat(outsideRoot, { bigint: true });
    expect(result).toEqual({ status: "stale" });
    expect(outsideAfter.mtimeNs).toBe(outsideBefore.mtimeNs);
    expect(await readFile(join(outsideRoot, "sentinel"), "utf8")).toBe("outside bytes\n");
    expect(await readdir(outsideRoot)).toEqual(["sentinel"]);
    expect(await readFile(join(displacedRoot, "App.swift"), "utf8")).toBe("original source\n");
  });

  test("never overwrites an occupied claim inside the transaction-owned directory", async () => {
    const root = await temporaryRoot();
    const path = join(root, "App.swift");
    await writeFile(path, "original source\n");
    const prepared = await mutation(path, "candidate source\n", root);
    let occupiedClaimPath = "";

    let caught: unknown;
    try {
      await applyIOSExistingFileTransaction([prepared], [async () => true], {
        afterRecoveryJournalPublished: async (journalPath) => {
          const journal = JSON.parse(await readFile(journalPath, "utf8")) as {
            mutations: Array<{ originalClaimPath: string }>;
          };
          occupiedClaimPath = journal.mutations[0]!.originalClaimPath;
          await writeFile(occupiedClaimPath, "newer claim occupant\n");
        },
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(IOSFileTransactionError);
    expect((caught as IOSFileTransactionError).code).toBe("commit-failed");
    expect(await readFile(path, "utf8")).toBe("original source\n");
    expect(await readFile(occupiedClaimPath, "utf8")).toBe("newer claim occupant\n");
  });

  test("restores a destination after SIGKILL immediately follows its claim", async () => {
    const root = await temporaryRoot();
    const path = join(root, "project.pbxproj");
    await writeFile(path, "original project\n");

    await crashFileTransaction(root, [path], "claim");

    await expect(lstat(path)).rejects.toMatchObject({ code: "ENOENT" });
    expect((await readdir(root)).some((name) => name.endsWith(".journal"))).toBe(true);
    await recoverIOSFileTransactions(root);
    expect(await readFile(path, "utf8")).toBe("original project\n");
    await expectNoTemporaryFiles(root);
  }, 15_000);

  test("rolls back every file after SIGKILL interrupts a later claim", async () => {
    const root = await temporaryRoot();
    const firstPath = join(root, "project.pbxproj");
    const secondPath = join(root, "App.swift");
    await writeFile(firstPath, "original project\n");
    await writeFile(secondPath, "original source\n");

    await crashFileTransaction(root, [firstPath, secondPath], "claim", 2);

    expect(await readFile(firstPath, "utf8")).toBe("candidate 0\n");
    await expect(lstat(secondPath)).rejects.toMatchObject({ code: "ENOENT" });
    await recoverIOSFileTransactions(root);
    expect(await readFile(firstPath, "utf8")).toBe("original project\n");
    expect(await readFile(secondPath, "utf8")).toBe("original source\n");
    await expectNoTemporaryFiles(root);
  }, 15_000);

  test("recovers SIGKILL during rollback without leaving the destination absent", async () => {
    const root = await temporaryRoot();
    const path = join(root, "App.swift");
    await writeFile(path, "original source\n");

    await crashFileTransaction(root, [path], "rollback-claim");

    await expect(lstat(path)).rejects.toMatchObject({ code: "ENOENT" });
    await recoverIOSFileTransactions(root);
    expect(await readFile(path, "utf8")).toBe("original source\n");
    await expectNoTemporaryFiles(root);
  }, 15_000);

  test("keeps committed bytes after SIGKILL interrupts artifact cleanup", async () => {
    const root = await temporaryRoot();
    const path = join(root, "App.swift");
    await writeFile(path, "original source\n");

    await crashFileTransaction(root, [path], "committed");

    expect(await readFile(path, "utf8")).toBe("candidate 0\n");
    await recoverIOSFileTransactions(root);
    expect(await readFile(path, "utf8")).toBe("candidate 0\n");
    await expectNoTemporaryFiles(root);
  }, 15_000);

  test("rejects recovery when a prepared parent is redirected outside its canonical root", async () => {
    const base = await temporaryRoot();
    const root = join(base, "project");
    const parent = join(root, "Sources");
    const displacedParent = join(base, "outside-Sources");
    const path = join(parent, "App.swift");
    await mkdir(parent, { recursive: true });
    await writeFile(path, "original source\n");

    await crashFileTransaction(root, [path], "claim");
    await rename(parent, displacedParent);
    await symlink(displacedParent, parent, "dir");

    let caught: unknown;
    try {
      await recoverIOSFileTransactions(root);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(IOSFileTransactionError);
    expect((caught as IOSFileTransactionError).code).toBe("recovery-failed");
    await expect(lstat(path)).rejects.toMatchObject({ code: "ENOENT" });
    expect((await readdir(displacedParent)).some((name) => name.endsWith(".recovery"))).toBe(true);
  }, 15_000);
});
