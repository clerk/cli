import { readDeps } from "../../lib/project-detector/index.js";
import type { Need } from "../../lib/deps.ts";

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

export type RunFormattersDeps = Need<{ system: "runInherit" }>;

export async function runFormatters(
  deps: RunFormattersDeps,
  cwd: string,
  files: string[],
): Promise<void> {
  if (files.length === 0) return;

  const projectDeps = await readDeps(cwd);
  if (!projectDeps) return;

  for (const formatter of FORMATTERS) {
    if (!(formatter.pkg in projectDeps)) continue;
    await deps.system.runInherit(formatter.binArgs(files), { cwd });
  }
}
