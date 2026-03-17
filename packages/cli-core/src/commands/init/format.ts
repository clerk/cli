import { readDeps } from "./context.js";

export async function runFormatters(cwd: string, files: string[]): Promise<void> {
  if (files.length === 0) return;

  const deps = await readDeps(cwd);
  if (!deps) return;

  const hasPrettier = "prettier" in deps;
  const hasBiome = "@biomejs/biome" in deps;

  if (!hasPrettier && !hasBiome) return;

  if (hasPrettier) {
    const proc = Bun.spawn(["npx", "prettier", "--ignore-unknown", "--write", ...files], {
      cwd,
      stdout: "ignore",
      stderr: "ignore",
    });
    await proc.exited;
  }

  if (hasBiome) {
    const proc = Bun.spawn(["npx", "@biomejs/biome", "format", "--write", ...files], {
      cwd,
      stdout: "ignore",
      stderr: "ignore",
    });
    await proc.exited;
  }
}
