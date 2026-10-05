import { readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { CliError, ERROR_CODE } from "../../../lib/errors.ts";

let selection: Promise<string | undefined> | undefined;
let note: string | undefined;

/** Why setup used an Xcode other than the xcode-select default, if it did. */
export function nonDefaultXcodeNote(): string | undefined {
  return note;
}

/** Choose a compatible installed Xcode for JSON projects without changing xcode-select. */
export async function compatibleXcode(signal?: AbortSignal): Promise<string | undefined> {
  // Cache a found Xcode, but let a failed or cancelled lookup run again.
  selection ??= selectXcode(signal).catch((error: unknown) => {
    selection = undefined;
    throw error;
  });
  return selection;
}

async function selectXcode(signal?: AbortSignal): Promise<string | undefined> {
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
  if ((current[0] ?? 0) >= 27) return undefined;
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
    if (chosen && (chosen.version[0] ?? 0) >= 27) {
      note = `Using Xcode ${chosen.version.join(".")} (${dirname(dirname(chosen.path))}): ${current.length ? `the default Xcode ${current.join(".")}` : "the default developer directory"} can't open project.xcproj projects.`;
      return chosen.path;
    }
  }
  throw new CliError(
    "This .xcproj project requires Xcode 27 or newer. Select a compatible Xcode in Xcode Settings > Locations, then rerun clerk init.",
    { code: ERROR_CODE.IOS_SETUP_BLOCKED },
  );
}
