/**
 * Framework detection for determining the correct publishable key env var name.
 * Reads package.json to identify the project's framework.
 */

import { join } from "node:path";

const FRAMEWORK_MAP: Array<{ dep: string; envVar: string }> = [
  { dep: "next", envVar: "NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY" },
  { dep: "expo", envVar: "EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY" },
  { dep: "astro", envVar: "PUBLIC_CLERK_PUBLISHABLE_KEY" },
  { dep: "nuxt", envVar: "NUXT_PUBLIC_CLERK_PUBLISHABLE_KEY" },
  { dep: "vite", envVar: "VITE_CLERK_PUBLISHABLE_KEY" },
];

const FALLBACK_KEY = "CLERK_PUBLISHABLE_KEY";

export async function detectPublishableKeyName(cwd: string): Promise<string> {
  const file = Bun.file(join(cwd, "package.json"));
  if (!(await file.exists())) return FALLBACK_KEY;

  let pkg: Record<string, Record<string, string>>;
  try {
    pkg = await file.json();
  } catch {
    return FALLBACK_KEY;
  }

  const allDeps = {
    ...pkg.dependencies,
    ...pkg.devDependencies,
  };

  for (const { dep, envVar } of FRAMEWORK_MAP) {
    if (dep in allDeps) return envVar;
  }

  return FALLBACK_KEY;
}
