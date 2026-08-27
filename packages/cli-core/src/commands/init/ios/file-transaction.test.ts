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
import { dirname, join } from "node:path";
import {
  applyIOSExistingFileTransaction,
  applyIOSFileTransaction,
  hashIOSFileBytes,
  IOSFileTransactionError,
  type IOSCreateFileMutation,
  type IOSExistingFileMutation,
} from "./file-transaction.ts";

const temporaryDirectories: string[] = [];

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "clerk-ios-file-transaction-"));
  temporaryDirectories.push(root);
  return root;
}

async function mutation(path: string, candidate: string): Promise<IOSExistingFileMutation> {
  const originalBytes = new Uint8Array(await readFile(path));
  const candidateBytes = new TextEncoder().encode(candidate);
  const info = await lstat(path);
  return {
    path,
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
): Promise<IOSCreateFileMutation> {
  const candidateBytes = new TextEncoder().encode(candidate);
  const parent = await lstat(dirname(path));
  return {
    kind: "create",
    path,
    expectedParentIdentity: { device: parent.dev, inode: parent.ino },
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
  const transactionFiles = (await readdir(root)).filter((name) => name.includes(".clerk-"));
  const claimedOriginals = transactionFiles.filter((name) => name.endsWith(".claimed"));
  expect(transactionFiles.filter((name) => name.endsWith(".tmp"))).toEqual([]);
  expect(
    (await Promise.all(claimedOriginals.map((name) => readFile(join(root, name), "utf8")))).sort(),
  ).toEqual([...expectedContents].sort());
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
    (await readdir(root)).some((name) => name.includes(".clerk-")),
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
