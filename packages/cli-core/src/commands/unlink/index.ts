import type { Need } from "../../lib/deps.ts";
import { dim, cyan } from "../../lib/color.ts";
import { CliError, ERROR_CODE, throwUserAbort } from "../../lib/errors.ts";

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

export type UnlinkDeps = Need<{
  configStore: "resolveProfile" | "removeProfile";
  git: "getGitRepoRoot";
  prompts: "confirm";
  mode: "isAgent" | "isHuman";
  log: "info" | "data";
}>;

export async function unlink(deps: UnlinkDeps, options: UnlinkOptions = {}): Promise<void> {
  if (deps.mode.isAgent()) {
    deps.log.data(AGENT_PROMPT);
    return;
  }

  const cwd = process.cwd();
  const existing = await deps.configStore.resolveProfile(cwd);

  if (!existing) {
    throw new CliError("This directory is not linked to a Clerk application", {
      code: ERROR_CODE.NOT_LINKED,
    });
  }

  const label = existing.profile.appId;
  const repoRoot = await deps.git.getGitRepoRoot();
  const displayPath = repoRoot ?? existing.path;

  if (deps.mode.isHuman() && !options.yes) {
    const ok = await deps.prompts.confirm({
      message: `Unlink ${label} from ${displayPath}?`,
      default: false,
    });
    if (!ok) {
      throwUserAbort();
    }
  }

  await deps.configStore.removeProfile(existing.path);
  deps.log.info(`\nUnlinked ${cyan(label)} from ${dim(displayPath)}`);
}
