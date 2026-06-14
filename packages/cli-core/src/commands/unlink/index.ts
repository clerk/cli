import type { Program } from "../../cli-program.ts";
import { confirm } from "../../lib/prompts.ts";
import { isAgent, isHuman } from "../../mode.ts";
import { resolveProfile, removeProfile } from "../../lib/config.ts";
import { getGitRepoRoot } from "../../lib/git.ts";
import { dim, cyan } from "../../lib/color.ts";
import { CliError, ERROR_CODE, throwUsageError, throwUserAbort } from "../../lib/errors.ts";
import { log } from "../../lib/log.ts";
import { intro, outro } from "../../lib/spinner.ts";
import { NEXT_STEPS } from "../../lib/next-steps.ts";

interface UnlinkOptions {
  yes?: boolean;
}

export async function unlink(options: UnlinkOptions = {}): Promise<void> {
  if (isAgent() && !options.yes) {
    throwUsageError("Pass --yes to unlink in agent mode.");
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

  intro("Unlinking project");

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
  outro(NEXT_STEPS.UNLINK);
}

export function registerUnlink(program: Program): void {
  program
    .command("unlink")
    .description("Unlink this project from its Clerk application")
    .option("--yes", "Skip confirmation prompt")
    .setExamples([
      { command: "clerk unlink", description: "Unlink with confirmation prompt" },
      { command: "clerk unlink --yes", description: "Skip confirmation" },
    ])
    .action(unlink);
}
