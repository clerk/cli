import { detectAvailableRunners, preferredRunner, runnerCommand } from "../../lib/runners.js";
import { isNonEmpty } from "../../lib/helpers/arrays.js";
import type { ProjectContext } from "./frameworks/types.js";

type FormatterConfig = {
  pkg: string;
  /** Bin invocation: bin name + flags + files. Prefixed with the runner at spawn time. */
  command: (files: string[]) => string[];
};

const FORMATTERS: FormatterConfig[] = [
  {
    pkg: "prettier",
    command: (files) => ["prettier", "--ignore-unknown", "--write", ...files],
  },
  {
    pkg: "@biomejs/biome",
    command: (files) => ["biome", "format", "--write", ...files],
  },
];

/**
 * Format scaffolded files with prettier or biome (whichever the project uses).
 *
 * Best-effort: failures are silent (stdio ignored, spawn errors swallowed)
 * because formatting is purely cosmetic and shouldn't break init.
 *
 * The runner is pinned so it fetches the formatter from the registry rather
 * than a project-local `node_modules/.bin` shadow — see {@link runnerCommand}.
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
    const command = runnerCommand(runner, formatter.pkg, formatter.command(files));
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
