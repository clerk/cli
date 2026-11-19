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
  gitStatus,
  gitTracked,
  removeEmptyBackupFolders,
  replaceProject,
  rollbackFiles,
} = fileOperations(setupError);
