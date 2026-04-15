import { detectAvailableRunners, preferredRunner, runnerCommand } from "../../lib/runners.js";
import { isNonEmpty } from "../../lib/helpers/arrays.js";
import type { ProjectContext } from "./frameworks/types.js";

type FormatterConfig = {
  pkg: string;
  /** Args after the runner: binary + flags + files. The runner is prepended at spawn time. */
  binArgs: (files: string[]) => string[];
};

const FORMATTERS: FormatterConfig[] = [
  {
    pkg: "prettier",
    binArgs: (files) => ["prettier", "--ignore-unknown", "--write", ...files],
  },
  {
    pkg: "@biomejs/biome",
    binArgs: (files) => ["@biomejs/biome", "format", "--write", ...files],
  },
];

/**
 * Format scaffolded files with prettier or biome (whichever the project uses).
 *
 * Best-effort: failures are silent (stdio ignored, spawn errors swallowed)
 * because formatting is purely cosmetic and shouldn't break init.
 */
export async function runFormatters(ctx: ProjectContext, files: string[]): Promise<void> {
  if (files.length === 0) return;
  if (Object.keys(ctx.deps).length === 0) return;

  const matchingFormatters = FORMATTERS.filter((f) => f.pkg in ctx.deps);
  if (matchingFormatters.length === 0) return;

  const available = detectAvailableRunners();
  if (!isNonEmpty(available)) return;
  const runner = preferredRunner(ctx.packageManager, available);

  for (const formatter of matchingFormatters) {
    const command = runnerCommand(runner, formatter.binArgs(files));
    try {
      const proc = Bun.spawn(command, {
        cwd: ctx.cwd,
        stdout: "ignore",
        stderr: "ignore",
      });
      await proc.exited;
    } catch {
      // Best-effort, see function doc comment.
    }
  }
}
