/**
 * `clerk deploy` and `clerk deploy status` in a folder with no linked
 * application.
 *
 * The lead sentence, the `not_linked` code, and exit 1 must not change:
 * agents and the skill's troubleshooting table match on them. What to run
 * next comes from the unlinked-folder module, so the same folder gets the
 * same advice from every command. The folder is read only here, on the
 * failure path, so a linked run reads nothing extra.
 */

import type { CliError } from "../../lib/errors.ts";
import {
  readUnlinkedFolder,
  rerunOf,
  unlinkedFolderError,
  type Rerun,
} from "../../lib/unlinked-folder.ts";

const LEAD = "No Clerk project linked to this directory.";

/** The error for a run with no linked app. `rerun` is the command that stopped, flags and all. */
export async function notLinkedError(rerun: Rerun): Promise<CliError> {
  return unlinkedFolderError(await readUnlinkedFolder(process.cwd()), { lead: LEAD, rerun });
}

/**
 * `clerk deploy` with the flags the run had. An agent creates production only
 * with `--domain`: a rerun without it prints the read-only report and exits 0,
 * with no production instance. The domain was validated (letters, digits,
 * dots, and hyphens) and lowercased, so it's safe to echo.
 */
export function deployRerun(options: { domain?: string; yes?: boolean }): Rerun {
  return rerunOf([
    "clerk deploy",
    options.domain && `--domain ${options.domain}`,
    options.yes && "--yes",
  ]);
}

/** `clerk deploy status`, keeping `--wait`. */
export function deployStatusRerun(options: { wait?: boolean }): Rerun {
  return rerunOf(["clerk deploy status", options.wait && "--wait"]);
}
