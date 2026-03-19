import { readDeps } from "./context.js";

type FormatterConfig = {
  pkg: string;
  args: (files: string[]) => string[];
};

const FORMATTERS: FormatterConfig[] = [
  {
    pkg: "prettier",
    args: (files) => ["npx", "prettier", "--ignore-unknown", "--write", ...files],
  },
  {
    pkg: "@biomejs/biome",
    args: (files) => ["npx", "@biomejs/biome", "format", "--write", ...files],
  },
];

export async function runFormatters(cwd: string, files: string[]): Promise<void> {
  if (files.length === 0) return;

  const deps = await readDeps(cwd);
  if (!deps) return;

  for (const formatter of FORMATTERS) {
    if (!(formatter.pkg in deps)) continue;

    const proc = Bun.spawn(formatter.args(files), {
      cwd,
      stdout: "ignore",
      stderr: "ignore",
    });
    await proc.exited;
  }
}
