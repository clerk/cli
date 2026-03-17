/**
 * Framework detection for determining the correct Clerk SDK and env var name.
 * Reads package.json to identify the project's framework.
 */

import { join } from "node:path";

export interface FrameworkInfo {
  dep: string;
  name: string;
  sdk: string;
  envVar: string;
}

// Order matters: more specific frameworks first (e.g. next before react, nuxt before vue)
const FRAMEWORK_MAP: FrameworkInfo[] = [
  {
    dep: "next",
    name: "Next.js",
    sdk: "@clerk/nextjs",
    envVar: "NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY",
  },
  { dep: "astro", name: "Astro", sdk: "@clerk/astro", envVar: "PUBLIC_CLERK_PUBLISHABLE_KEY" },
  { dep: "nuxt", name: "Nuxt", sdk: "@clerk/nuxt", envVar: "NUXT_PUBLIC_CLERK_PUBLISHABLE_KEY" },
  {
    dep: "@tanstack/react-start",
    name: "TanStack Start",
    sdk: "@clerk/tanstack-react-start",
    envVar: "VITE_CLERK_PUBLISHABLE_KEY",
  },
  {
    dep: "react-router",
    name: "React Router",
    sdk: "@clerk/react-router",
    envVar: "VITE_CLERK_PUBLISHABLE_KEY",
  },
  { dep: "vue", name: "Vue", sdk: "@clerk/vue", envVar: "VITE_CLERK_PUBLISHABLE_KEY" },
  {
    dep: "expo",
    name: "Expo",
    sdk: "@clerk/expo",
    envVar: "EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY",
  },
  { dep: "react", name: "React", sdk: "@clerk/react", envVar: "VITE_CLERK_PUBLISHABLE_KEY" },
  { dep: "express", name: "Express", sdk: "@clerk/express", envVar: "CLERK_PUBLISHABLE_KEY" },
  { dep: "fastify", name: "Fastify", sdk: "@clerk/fastify", envVar: "CLERK_PUBLISHABLE_KEY" },
];

const FALLBACK_KEY = "CLERK_PUBLISHABLE_KEY";

export async function readDeps(cwd: string): Promise<Record<string, string> | null> {
  const file = Bun.file(join(cwd, "package.json"));
  if (!(await file.exists())) return null;

  try {
    const pkg = await file.json();
    return { ...pkg.dependencies, ...pkg.devDependencies };
  } catch {
    return null;
  }
}

export async function detectFramework(cwd: string): Promise<FrameworkInfo | null> {
  const allDeps = await readDeps(cwd);
  if (!allDeps) return null;

  for (const fw of FRAMEWORK_MAP) {
    if (fw.dep in allDeps) return fw;
  }

  return null;
}

export async function detectPublishableKeyName(cwd: string): Promise<string> {
  const fw = await detectFramework(cwd);
  return fw?.envVar ?? FALLBACK_KEY;
}
