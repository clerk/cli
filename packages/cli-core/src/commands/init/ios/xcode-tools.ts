import { readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { CliError, ERROR_CODE } from "../../../lib/errors.ts";

const selections = new Map<number, Promise<string | undefined>>();
let note: string | undefined;

/** Why setup used an Xcode other than the xcode-select default, if it did. */
export function nonDefaultXcodeNote(): string | undefined {
  return note;
}

/**
 * Choose an installed Xcode of at least `minimumMajor` without changing xcode-select:
 * Xcode 27 for JSON projects, or any full Xcode when xcode-select points at the
 * Command Line Tools. Undefined means the default developer directory is fine.
 */
export async function compatibleXcode(
  minimumMajor: number,
  signal?: AbortSignal,
): Promise<string | undefined> {
  // Cache a found Xcode, but let a failed or cancelled lookup run again.
  let selection = selections.get(minimumMajor);
  if (!selection) {
    selection = selectXcode(minimumMajor, signal).catch((error: unknown) => {
      selections.delete(minimumMajor);
      throw error;
    });
    selections.set(minimumMajor, selection);
  }
  return selection;
}

async function selectXcode(
  minimumMajor: number,
  signal?: AbortSignal,
): Promise<string | undefined> {
  const version = async (developerDir?: string): Promise<number[]> => {
    signal?.throwIfAborted();
    try {
      const child = Bun.spawn(["xcodebuild", "-version"], {
        env: developerDir ? { ...process.env, DEVELOPER_DIR: developerDir } : process.env,
        stdout: "pipe",
        stderr: "ignore",
        stdin: "ignore",
        timeout: 10_000,
        signal,
      });
      const output = await new Response(child.stdout).text();
      if ((await child.exited) !== 0) return [];
      return (
        /Xcode (\d+)(?:\.(\d+))?/
          .exec(output)
          ?.slice(1)
          .map((n) => Number(n ?? 0)) ?? []
      );
    } catch {
      signal?.throwIfAborted();
      return [];
    }
  };
  const current = await version();
  if ((current[0] ?? 0) >= minimumMajor) return undefined;
  if (!process.env.DEVELOPER_DIR) {
    const applications = await readdir("/Applications").catch(() => [] as string[]);
    const candidates = await Promise.all(
      applications
        .filter((name) => /^Xcode.*\.app$/.test(name))
        .map(async (name) => {
          const path = join("/Applications", name, "Contents/Developer");
          return { path, version: await version(path) };
        }),
    );
    candidates.sort(
      (a, b) =>
        (b.version[0] ?? 0) - (a.version[0] ?? 0) || (b.version[1] ?? 0) - (a.version[1] ?? 0),
    );
    const chosen = candidates[0];
    if (chosen && (chosen.version[0] ?? 0) >= minimumMajor) {
      const reason = !current.length
        ? "the selected developer directory isn't a full Xcode"
        : `the default Xcode ${current.join(".")} can't open project.xcproj projects`;
      note = `Using Xcode ${chosen.version.join(".")} (${dirname(dirname(chosen.path))}): ${reason}.`;
      return chosen.path;
    }
  }
  throw new CliError(
    minimumMajor > 1
      ? "This .xcproj project requires Xcode 27 or newer. Select a compatible Xcode in Xcode Settings > Locations, then rerun clerk init."
      : "Setup needs Xcode, and the selected developer directory isn't a full Xcode. Install Xcode, or select it with `sudo xcode-select -s /Applications/Xcode.app`, then rerun clerk init.",
    { code: ERROR_CODE.IOS_SETUP_BLOCKED },
  );
}
