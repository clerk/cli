/**
 * Agent-mode `clerk link`'s stops, when it can't choose an application.
 *
 * The lead sentence stays verbatim: agents and the skill's troubleshooting
 * table match on it. After `link`'s own reason, the advice comes from the
 * unlinked-folder module, so the same folder gets the same advice from every
 * command, and its commands go into the error's `examples`.
 */

import { CliError, ERROR_CODE, EXIT_CODE } from "../../lib/errors.ts";
import {
  unlinkedFolderNextStep,
  type LinkStop,
  type Rerun,
  type UnlinkedFolder,
} from "../../lib/unlinked-folder.ts";

export const AGENT_LEAD = "Cannot select an application in agent mode.";

/** What `link` knew when it stopped. */
export interface AgentStop {
  /** `link`'s reason, as sentences; undefined when it has none. */
  reason?: string;
  /** What auto-link knew; absent for a stop before any lookup. */
  linkStop?: LinkStop;
  /**
   * The caller's command to run again once the folder is linked (`init`,
   * `migrate`). `clerk link`'s own stop passes none.
   */
  rerun?: Rerun;
}

/**
 * The stop's error: `usage_error`, exit 2. `folder` is classified when the
 * stop is built, after any claim, so a claim that spent the init token reads
 * as the folder's keys.
 */
export function agentStopError(folder: UnlinkedFolder, { reason, linkStop, rerun }: AgentStop) {
  const step = unlinkedFolderNextStep(folder, { agent: true, rerun, linkStop });
  return new CliError([AGENT_LEAD, reason, step.text].filter(Boolean).join(" "), {
    code: ERROR_CODE.USAGE_ERROR,
    exitCode: EXIT_CODE.USAGE,
    examples: step.examples,
  });
}
