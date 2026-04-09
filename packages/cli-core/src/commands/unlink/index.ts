import { confirm } from "@inquirer/prompts";
import { isAgent, isHuman } from "../../mode.ts";
import { resolveProfile, removeProfile } from "../../lib/config.ts";
import { getGitRepoRoot } from "../../lib/git.ts";
import { dim, cyan } from "../../lib/color.ts";
import { CliError, ERROR_CODE, throwUserAbort } from "../../lib/errors.ts";
import { log } from "../../lib/log.ts";

const AGENT_PROMPT = `You are unlinking a Clerk application from the current project directory.

## Steps

1. Resolve the current profile for the working directory using the config file at ~/.clerk/config.json.
2. If no profile is found, inform the user that the directory is not linked.
3. Remove the profile entry from ~/.clerk/config.json.

## CLI Usage

\`\`\`
clerk unlink        # Interactive confirmation before unlinking
clerk unlink --yes  # Skip confirmation
\`\`\``;

interface UnlinkOptions {
  yes?: boolean;
}

export async function unlink(options: UnlinkOptions = {}): Promise<void> {
  if (isAgent()) {
    log.data(AGENT_PROMPT);
    return;
  }

  const cwd = process.cwd();
  const existing = await resolveProfile(cwd);

  if (!existing) {
    throw new CliError("This directory is not linked to a Clerk application", {
      code: ERROR_CODE.NOT_LINKED,
    });
  }

  const label = existing.profile.appId;
  const repoRoot = await getGitRepoRoot();
  const displayPath = repoRoot ?? existing.path;

  if (isHuman() && !options.yes) {
    const ok = await confirm({
      message: `Unlink ${label} from ${displayPath}?`,
      default: false,
    });
    if (!ok) {
      throwUserAbort();
    }
  }

  await removeProfile(existing.path);
  log.data(`\nUnlinked ${cyan(label)} from ${dim(displayPath)}`);
}
