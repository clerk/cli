import { fileOperations } from "../native/files.ts";
import { setupError } from "./types.ts";

export type { AppliedFile, FileSnapshot } from "../native/files.ts";

/** The shared native file operations, raising Android setup errors. */
export const {
  containedPath,
  assertAbsent,
  createFile,
  snapshotFile,
  assertUnchanged,
  gitDirty,
  gitTracked,
  removeEmptyBackupFolders,
  replaceProject,
  rollbackFiles,
} = fileOperations(setupError);
