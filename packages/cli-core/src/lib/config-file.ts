import { join } from "node:path";

// Ordered precedence for locating a project config file: YAML wins over JSON.
export const CONFIG_FILE_PRECEDENCE = [
  ".clerk/config.yaml",
  ".clerk/config.yml",
  ".clerk/config.json",
] as const;

// Returns the path of the first existing config file (relative to `dir`,
// default cwd), trying YAML before JSON. Returns undefined if none exist.
export async function resolveConfigFile(dir = "."): Promise<string | undefined> {
  for (const rel of CONFIG_FILE_PRECEDENCE) {
    const path = join(dir, rel);
    if (await Bun.file(path).exists()) return path;
  }
  return undefined;
}
