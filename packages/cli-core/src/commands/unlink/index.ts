import { confirm } from "@inquirer/prompts";
import { isAgent, isHuman } from "../../mode.js";
import { resolveProfile, removeProfile } from "../../lib/config.js";
import { getGitRepoRoot } from "../../lib/git.js";
import { dim, cyan } from "../../lib/color.js";
import { CliError, throwUserAbort } from "../../lib/errors.js";

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
    console.log(AGENT_PROMPT);
    return;
  }

  const cwd = process.cwd();
  const existing = await resolveProfile(cwd);

  if (!existing) {
    throw new CliError("This directory is not linked to a Clerk application.");
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
  console.log(`\nUnlinked ${cyan(label)} from ${dim(displayPath)}`);
}
