import { join } from "node:path";

const DEFAULT_STABLE_RELEASE_NOTES_DIR = join(import.meta.dir, "../../.github/release-notes");

export function stableReleaseNotesPath(
  version: string,
  notesDir = DEFAULT_STABLE_RELEASE_NOTES_DIR,
): string {
  return join(notesDir, `v${version}.md`);
}

export async function getStableReleaseCreateArgs(
  version: string,
  notesDir = DEFAULT_STABLE_RELEASE_NOTES_DIR,
): Promise<string[]> {
  const tagName = `v${version}`;
  const args = ["gh", "release", "create", tagName, "--generate-notes"];
  const notesPath = stableReleaseNotesPath(version, notesDir);

  if (!(await Bun.file(notesPath).exists())) {
    return args;
  }

  const notes = (await Bun.file(notesPath).text()).trim();
  if (!notes) {
    return args;
  }

  return [...args, "--notes", notes];
}
