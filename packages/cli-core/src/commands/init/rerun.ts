/**
 * The `clerk init` to run again when `link` stops inside it, with the flags
 * this run had. Left out, a flag changes the rerun: agent mode installs the
 * agent skills without asking, so a rerun without `--no-skills` installs what
 * the agent declined, and one without `--framework` or `--pm` detects them
 * again, which in a monorepo can pick others. Values are shell-quoted, as
 * `migrate` quotes the flags it carries; none of `init`'s flags holds a secret.
 */

import { relative } from "node:path";
import { quoteArg } from "../../lib/json-body.ts";
import { rerunOf, type Rerun } from "../../lib/unlinked-folder.ts";
import { RERUN_FLAGS } from "./flags.ts";
import type { InitOptions } from "./index.ts";

/**
 * Repeats `RERUN_FLAGS`; the flags in `NOT_RERUN` are left out. `where` says
 * where `init` ran and the folder of the project it just created
 * (`--starter`, or `--framework` in a folder with no project): the commands
 * must run in that folder. A key exported in the shell can make `link` stop
 * there, after a failed app list.
 */
export function initRerun(
  options: InitOptions,
  where?: { from: string; projectDir: string },
): Rerun {
  const flags = RERUN_FLAGS.flatMap(([key, flag]): string[] => {
    // A project this run just created already holds its Bundle ID; passing it
    // again would mask what Xcode reports.
    if (key === "bundleId" && where) return [];
    const value = options[key];
    if (key === "skills") return value === false ? [flag] : [];
    if (value === undefined || value === false) return [];
    return value === true ? [flag] : [flag, quoteArg(String(value))];
  });
  const rerun = rerunOf(["clerk init", ...flags]);
  const name = where ? relative(where.from, where.projectDir) : "";
  if (!where || !name) return rerun;
  return {
    clause: `run \`${rerun.command}\` again in \`${name}\``,
    command: rerun.command,
    folder: { name, path: where.projectDir },
  };
}
