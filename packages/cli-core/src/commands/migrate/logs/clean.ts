/**
 * `clerk migrate logs clean` — delete the local log files.
 *
 * Ported from the standalone migration-tool's `src/clean-logs/index.ts`.
 *
 * Destructive, and it sits one word away from `clerk migrate delete`, which
 * destroys something entirely different (users in a Clerk instance). So the
 * confirmation is not optional: interactive runs prompt, and non-interactive
 * ones must say `-y` rather than being allowed to assume.
 */

import fs from "node:fs";
import { throwUsageError, throwUserAbort } from "../../../lib/errors.ts";
import { log } from "../../../lib/log.ts";
import { confirm } from "../../../lib/prompts.ts";
import { withGutter } from "../../../lib/spinner.ts";
import { isAgent, isHuman } from "../../../mode.ts";
import { listLogFiles } from "../lib/log-files.ts";
import { getLogDir, resolveLogDir } from "../lib/logger.ts";

export type LogsCleanOptions = {
  yes?: boolean;
};

export async function clean(options: LogsCleanOptions = {}): Promise<void> {
  await withGutter("Cleaning migration logs", async () => {
    await resolveLogDir();
    const files = listLogFiles();

    if (files.length === 0) {
      log.info(`No migration logs to clean in ${getLogDir()}.`);
      return;
    }

    const label = `${files.length} log file${files.length === 1 ? "" : "s"}`;

    if (!options.yes) {
      if (isAgent() || !isHuman()) {
        throwUsageError(
          `\`clerk migrate logs clean\` deletes ${label} from ${getLogDir()} and cannot prompt here. Pass -y to confirm.`,
          undefined,
          undefined,
          [
            {
              command: "clerk migrate logs clean -y",
              description: "Delete every migration log without prompting",
            },
          ],
        );
      }

      const proceed = await confirm({ message: `Delete ${label}?`, default: false });
      if (!proceed) throwUserAbort();
    }

    let deleted = 0;
    const failures: string[] = [];

    for (const file of files) {
      try {
        fs.unlinkSync(file.path);
        deleted++;
      } catch (error) {
        failures.push(`${file.name}: ${(error as Error).message}`);
      }
    }

    for (const failure of failures) log.warn(`Could not delete ${failure}`);

    log.success(`Deleted ${deleted} log file${deleted === 1 ? "" : "s"}.`);
    if (failures.length > 0) process.exitCode = 1;
  });
}
