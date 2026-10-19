import { constants } from "node:fs";
import { link, lstat, mkdir, open, realpath, rename, rmdir, unlink } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { randomUUID } from "node:crypto";
import { setupError } from "./types.ts";

export interface FileSnapshot {
  path: string;
  source: string;
  mode: number;
  device: number;
  inode: number;
}

export async function containedPath(
  root: string,
  path: string,
  allowMissingLeaf = false,
): Promise<string> {
  const base = await realpath(root);
  const destination = resolve(base, path);
  const rel = relative(base, destination);
  if (!rel || isAbsolute(rel) || rel.split(sep).includes(".."))
    throw setupError("Path is outside the selected project root.");
  let cursor = base;
  for (const part of rel.split(sep)) {
    cursor = join(cursor, part);
    const info = await lstat(cursor).catch((error: NodeJS.ErrnoException) => {
      if (allowMissingLeaf && cursor === destination && error.code === "ENOENT") return undefined;
      throw error;
    });
    if (info?.isSymbolicLink()) throw setupError("Symbolic links require manual project setup.");
  }
  return destination;
}

export async function assertAbsent(root: string, path: string): Promise<string> {
  const destination = await containedPath(root, path, true);
  try {
    await lstat(destination);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return destination;
    throw error;
  }
  throw setupError("A planned new file already exists. Review a fresh setup plan.", true);
}

export async function createFile(root: string, path: string, content: string): Promise<void> {
  const destination = await assertAbsent(root, path);
  const candidate = `${destination}.clerk-${randomUUID()}.tmp`;
  const handle = await open(candidate, "wx", 0o644);
  try {
    await handle.writeFile(content);
    await handle.sync();
    await handle.close();
    await assertAbsent(root, path);
    await link(candidate, destination);
  } finally {
    await handle.close();
    await unlink(candidate);
  }
}

export async function snapshotFile(root: string, path: string): Promise<FileSnapshot> {
  const destination = await containedPath(root, path);
  const handle = await open(destination, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > 15_000_000)
      throw setupError("Project document is not a supported regular file.");
    const bytes = await handle.readFile();
    return {
      path,
      source: new TextDecoder("utf-8", { fatal: true }).decode(bytes),
      mode: info.mode & 0o777,
      device: info.dev,
      inode: info.ino,
    };
  } finally {
    await handle.close();
  }
}

export async function assertUnchanged(root: string, snapshot: FileSnapshot): Promise<void> {
  const current = await snapshotFile(root, snapshot.path);
  if (
    current.source !== snapshot.source ||
    current.mode !== snapshot.mode ||
    current.device !== snapshot.device ||
    current.inode !== snapshot.inode
  ) {
    throw setupError("The project changed after its preview. Review a fresh plan.", true);
  }
}

export async function gitDirty(root: string, path: string): Promise<boolean> {
  const child = Bun.spawn(["git", "status", "--porcelain", "--", path], {
    cwd: root,
    stdout: "pipe",
    stderr: "ignore",
    timeout: 5_000,
  });
  const [output, code] = await Promise.all([new Response(child.stdout).text(), child.exited]);
  // A non-Git project can still be edited; a backup is always created.
  return code === 0 && output.trim().length > 0;
}

/** Whether git tracks the file, so it can restore it; false for untracked, ignored, or non-git files. */
export async function gitTracked(root: string, path: string): Promise<boolean> {
  const child = Bun.spawn(["git", "ls-files", "--error-unmatch", "--", path], {
    cwd: root,
    stdout: "ignore",
    stderr: "ignore",
    timeout: 5_000,
  });
  return (await child.exited) === 0;
}

/** Removes the backup folders when they hold nothing, so setup leaves no empty folders behind. */
export async function removeEmptyBackupFolders(root: string): Promise<void> {
  for (const dir of [join(root, ".clerk", "backups"), join(root, ".clerk")])
    await rmdir(dir).catch(() => {});
}

export async function replaceProject(
  root: string,
  snapshot: FileSnapshot,
  content: string,
  backup = true,
): Promise<string | undefined> {
  await assertUnchanged(root, snapshot);
  if (content === snapshot.source) return undefined;
  const destination = await containedPath(root, snapshot.path);
  const suffix = randomUUID();
  // Outside the app's folders: Xcode 16+ adds every file in a synchronized folder to
  // the target, so a backup beside the file would be copied into the app bundle.
  const backupPath = join(
    await realpath(root),
    ".clerk",
    "backups",
    `${snapshot.path.split(/[\\/]/).join("--")}.clerk-backup-${suffix}`,
  );
  if (backup) await mkdir(dirname(backupPath), { recursive: true });
  const candidate = join(dirname(destination), `.clerk-project-${suffix}.tmp`);
  const writeExclusive = async (path: string, source: string) => {
    const handle = await open(path, "wx", snapshot.mode);
    try {
      await handle.chmod(snapshot.mode);
      await handle.writeFile(source);
      await handle.sync();
    } catch (error) {
      // This call created the file, so a partial copy is safe to remove.
      await handle.close();
      await unlink(path).catch(() => {});
      throw error;
    }
    await handle.close();
  };
  if (backup)
    await writeExclusive(backupPath, snapshot.source).catch(async (error: unknown) => {
      await removeEmptyBackupFolders(root);
      throw error;
    });
  try {
    await writeExclusive(candidate, content);
    await assertUnchanged(root, snapshot);
    await rename(candidate, destination);
  } catch (error) {
    // The original was never replaced, so its backup would only be an unreported copy.
    if (backup) {
      await unlink(backupPath).catch(() => {});
      await removeEmptyBackupFolders(root);
    }
    throw error;
  } finally {
    await unlink(candidate).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    });
  }
  return backup ? relative(await realpath(root), backupPath) : undefined;
}

export interface AppliedFile {
  before?: FileSnapshot;
  after: FileSnapshot;
}

// Recover ordinary in-process write failures, without replacing subsequent edits.
// The original backups remain available. This is not crash recovery.
export async function rollbackFiles(root: string, files: AppliedFile[]) {
  const restored: string[] = [],
    needsReview: string[] = [];
  for (const { before, after } of [...files].reverse()) {
    try {
      await assertUnchanged(root, after);
      if (before) await replaceProject(root, after, before.source, false);
      else await unlink(await containedPath(root, after.path));
      restored.push(after.path);
    } catch {
      needsReview.push(after.path);
    }
  }
  return { restored, needsReview };
}
