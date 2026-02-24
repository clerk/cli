import { confirm } from "@inquirer/prompts";
import { isAgent, isHuman } from "../../mode.js";
import { resolveProfile, removeProfile } from "../../lib/config.js";

const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
const cyan = (s: string) => `\x1b[36m${s}\x1b[0m`;

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
    console.error("This directory is not linked to a Clerk application.");
    process.exit(1);
  }

  const label = existing.profile.appId;

  if (isHuman() && !options.yes) {
    const ok = await confirm({
      message: `Unlink ${label} from ${existing.path}?`,
      default: false,
    });
    if (!ok) {
      console.log("Aborted.");
      return;
    }
  }

  await removeProfile(existing.path);
  console.log(`\nUnlinked ${cyan(label)} from ${dim(existing.path)}`);
}
