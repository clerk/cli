import { confirm } from "@inquirer/prompts";
import { isHuman } from "../../mode.js";
import { resolveProfile, removeProfile } from "../../lib/config.js";
import { getGitRepoRoot } from "../../lib/git.js";
import { createCommandOutput } from "../../lib/cli.js";
import { CliError, throwUserAbort } from "../../lib/errors.js";

interface UnlinkOptions {
  yes?: boolean;
}

export async function unlink(options: UnlinkOptions = {}): Promise<void> {
  using out = createCommandOutput("unlink");

  const cwd = process.cwd();
  const existing = await resolveProfile(cwd);

  if (!existing) {
    if (isHuman()) {
      throw new CliError("This directory is not linked to a Clerk application.");
    }
    out.add("linked", false, "This directory is not linked to a Clerk application");
    return;
  }

  const label = existing.profile.appId;
  const repoRoot = await getGitRepoRoot();
  const displayPath = repoRoot ?? existing.path;

  out.add("linked", true, `Linked to ${label} in ${displayPath}`);

  if (isHuman() && !options.yes) {
    const ok = await confirm({
      message: `Unlink ${label} from ${displayPath}?`,
      default: false,
    });
    if (!ok) throwUserAbort();
  }

  await removeProfile(existing.path);
  out.add("unlinked", true, `Unlinked ${label} from ${displayPath}`);
}
