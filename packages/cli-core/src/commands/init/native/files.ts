import { constants } from "node:fs";
import { link, lstat, mkdir, open, realpath, rename, rmdir, unlink } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { randomUUID } from "node:crypto";
import type { SetupErrorFactory } from "./types.ts";

export interface FileSnapshot {
  path: string;
  source: string;
  mode: number;
  device: number;
  inode: number;
}

export interface AppliedFile {
  before?: FileSnapshot;
  after: FileSnapshot;
}

/**
 * The file operations native setup shares: snapshots that detect edits made since a preview,
 * exclusive creates, backed-up replacements, and rollback of earlier writes. Each engine binds the
 * set to its own error factory so a refusal carries that platform's error code.
 */
export function fileOperations(setupError: SetupErrorFactory) {
  /**
   * The absolute path of `path` inside `root`, refusing paths that escape it or pass through a
   * symbolic link. With `allowMissing`, a path whose tail doesn't exist yet (a new file, perhaps in
   * new folders) is accepted: nothing below a missing folder can be a link.
   */
  async function containedPath(root: string, path: string, allowMissing = false): Promise<string> {
    const base = await realpath(root);
    const destination = resolve(base, path);
    const rel = relative(base, destination);
    if (!rel || isAbsolute(rel) || rel.split(sep).includes(".."))
      throw setupError("Path is outside the selected project root.");
    let cursor = base;
    for (const part of rel.split(sep)) {
      cursor = join(cursor, part);
      const info = await lstat(cursor).catch((error: NodeJS.ErrnoException) => {
        if (allowMissing && error.code === "ENOENT") return undefined;
        throw error;
      });
      if (!info) break;
      if (info.isSymbolicLink()) throw setupError("Symbolic links require manual project setup.");
    }
    return destination;
  }

  async function assertAbsent(root: string, path: string): Promise<string> {
    const destination = await containedPath(root, path, true);
    try {
      await lstat(destination);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return destination;
      throw error;
    }
    throw setupError("A planned new file already exists. Review a fresh setup plan.", true);
  }

  async function createFile(root: string, path: string, content: string): Promise<void> {
    const destination = await assertAbsent(root, path);
    await mkdir(dirname(destination), { recursive: true });
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

  async function snapshotFile(root: string, path: string): Promise<FileSnapshot> {
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

  async function assertUnchanged(root: string, snapshot: FileSnapshot): Promise<void> {
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

  /**
   * Spawns git, or returns undefined when there is no git executable (Bun.spawn throws before the
   * child starts). A machine without Git is still a valid place to edit a project. The environment
   * is passed explicitly so the lookup follows the current PATH, not the one at startup.
   */
  function spawnGit(root: string, args: string[], stdout: "pipe" | "ignore") {
    try {
      return Bun.spawn(["git", ...args], {
        cwd: root,
        env: process.env,
        stdout,
        stderr: "ignore",
        timeout: 5_000,
      });
    } catch {
      return undefined;
    }
  }

  /**
   * Whether the file has uncommitted changes. "unknown" when git is missing, the project isn't a
   * repository, or `git status` fails or times out: setup still proceeds (a backup is always
   * created), but nothing may treat the file as clean.
   */
  async function gitStatus(root: string, path: string): Promise<"clean" | "dirty" | "unknown"> {
    const child = spawnGit(root, ["status", "--porcelain", "--", path], "pipe");
    if (!child) return "unknown";
    const [output, code] = await Promise.all([new Response(child.stdout).text(), child.exited]);
    if (code !== 0) return "unknown";
    return output.trim().length > 0 ? "dirty" : "clean";
  }

  /**
   * Whether git tracks the file as a normal entry, so it can restore it; false for untracked,
   * ignored, or non-git files, and for entries whose edits `git status` hides (assume-unchanged,
   * skip-worktree), since restoring those would drop the edits.
   */
  async function gitTracked(root: string, path: string): Promise<boolean> {
    const child = spawnGit(root, ["ls-files", "-v", "--error-unmatch", "--", path], "pipe");
    if (!child) return false;
    const [output, code] = await Promise.all([new Response(child.stdout).text(), child.exited]);
    return code === 0 && output.startsWith("H ");
  }

  /** Removes the backup folders when they hold nothing, so setup leaves no empty folders behind. */
  async function removeEmptyBackupFolders(root: string): Promise<void> {
    for (const dir of [join(root, ".clerk", "backups"), join(root, ".clerk")])
      await rmdir(dir).catch(() => {});
  }

  async function replaceProject(
    root: string,
    snapshot: FileSnapshot,
    content: string,
    backup = true,
  ): Promise<string | undefined> {
    await assertUnchanged(root, snapshot);
    if (content === snapshot.source) return undefined;
    const destination = await containedPath(root, snapshot.path);
    const suffix = randomUUID();
    // Outside the app's folders: Xcode 16+ adds every file in a synchronized folder to the
    // target, and Gradle source sets pick up every file under src/, so a backup beside the
    // file would be bundled or compiled.
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

  // Recover ordinary in-process write failures, without replacing subsequent edits.
  // The original backups remain available. This is not crash recovery.
  async function rollbackFiles(root: string, files: AppliedFile[]) {
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

  return {
    containedPath,
    assertAbsent,
    createFile,
    snapshotFile,
    assertUnchanged,
    gitStatus,
    gitTracked,
    removeEmptyBackupFolders,
    replaceProject,
    rollbackFiles,
  };
}
