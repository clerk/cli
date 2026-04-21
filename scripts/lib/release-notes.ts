import { join } from "node:path";

const DEFAULT_STABLE_RELEASE_NOTES_DIR = join(import.meta.dir, "../../.github/release-notes");

export type StableReleaseCreateArgs = {
  args: string[];
  notesPath?: string;
};

export async function getStableReleaseCreateArgs(
  version: string,
  notesDir = DEFAULT_STABLE_RELEASE_NOTES_DIR,
): Promise<StableReleaseCreateArgs> {
  const tagName = `v${version}`;
  const args = ["gh", "release", "create", tagName, "--generate-notes"];
  const notesPath = join(notesDir, `v${version}.md`);

  if (!(await Bun.file(notesPath).exists())) {
    return { args };
  }

  const notes = (await Bun.file(notesPath).text()).trim();
  if (!notes) {
    return { args };
  }

  return { args: [...args, "--notes", notes], notesPath };
}
