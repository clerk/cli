/**
 * Framework detection for determining the correct Clerk SDK and env var name.
 * Reads package.json to identify the project's framework.
 */

import { join } from "node:path";
import { log } from "./log.ts";

export interface FrameworkInfo {
  dep: string;
  name: string;
  sdk: string;
  /** Override the install specifier when it differs from the package name (e.g. pinned version). */
  sdkInstall?: string;
  envVar: string;
  /** Override for secret key env var name. Defaults to CLERK_SECRET_KEY when omitted. */
  secretKeyEnvVar?: string;
  /** Preferred env file for secrets. Frameworks that gitignore `.env` use it
   *  directly; Vite-based frameworks use `.env.local` since `.env` is tracked. */
  envFile: ".env" | ".env.local";
  /** When true, the framework's Clerk SDK supports keyless mode (auto-generated
   *  temporary dev keys). Frameworks without keyless support require API keys
   *  and must authenticate during `clerk init`. */
  supportsKeyless?: boolean;
}

// Order matters: more specific frameworks first (e.g. next before react, nuxt before vue)
export const FRAMEWORK_MAP: FrameworkInfo[] = [
  {
    dep: "next",
    name: "Next.js",
    sdk: "@clerk/nextjs",
    envVar: "NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY",
    envFile: ".env",
    supportsKeyless: true,
  },
  {
    dep: "astro",
    name: "Astro",
    sdk: "@clerk/astro",
    envVar: "PUBLIC_CLERK_PUBLISHABLE_KEY",
    envFile: ".env",
    supportsKeyless: true,
  },
  {
    dep: "nuxt",
    name: "Nuxt",
    sdk: "@clerk/nuxt",
    // TODO: Remove sdkInstall once @clerk/nuxt stable (>=2.2.0) ships with keyless support
    sdkInstall: "@clerk/nuxt@2.2.0-snapshot.v20260413174426",
    envVar: "NUXT_PUBLIC_CLERK_PUBLISHABLE_KEY",
    secretKeyEnvVar: "NUXT_CLERK_SECRET_KEY",
    envFile: ".env",
    supportsKeyless: true,
  },
  {
    dep: "@tanstack/react-start",
    name: "TanStack Start",
    sdk: "@clerk/tanstack-react-start",
    envVar: "VITE_CLERK_PUBLISHABLE_KEY",
    envFile: ".env.local",
    supportsKeyless: true,
  },
  {
    dep: "react-router",
    name: "React Router",
    sdk: "@clerk/react-router",
    envVar: "VITE_CLERK_PUBLISHABLE_KEY",
    envFile: ".env.local",
    supportsKeyless: true,
  },
  {
    dep: "vue",
    name: "Vue",
    sdk: "@clerk/vue",
    envVar: "VITE_CLERK_PUBLISHABLE_KEY",
    envFile: ".env.local",
  },
  {
    dep: "expo",
    name: "Expo",
    sdk: "@clerk/expo",
    envVar: "EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY",
    envFile: ".env.local",
  },
  {
    dep: "react",
    name: "React",
    sdk: "@clerk/react",
    envVar: "VITE_CLERK_PUBLISHABLE_KEY",
    envFile: ".env.local",
  },
  {
    dep: "vite",
    name: "JavaScript",
    sdk: "@clerk/clerk-js",
    envVar: "VITE_CLERK_PUBLISHABLE_KEY",
    envFile: ".env.local",
  },
  {
    dep: "express",
    name: "Express",
    sdk: "@clerk/express",
    envVar: "CLERK_PUBLISHABLE_KEY",
    envFile: ".env.local",
  },
  {
    dep: "fastify",
    name: "Fastify",
    sdk: "@clerk/fastify",
    envVar: "CLERK_PUBLISHABLE_KEY",
    envFile: ".env.local",
  },
];

const FRAMEWORK_ALIASES: Record<string, string> = {
  "tanstack-start": "@tanstack/react-start",
  javascript: "vite",
  js: "vite",
};

export function lookupFramework(name: string): FrameworkInfo | null {
  const dep = FRAMEWORK_ALIASES[name] ?? name;
  return FRAMEWORK_MAP.find((fw) => fw.dep === dep) ?? null;
}

export const FRAMEWORK_NAMES = FRAMEWORK_MAP.map((fw) => {
  const alias = Object.entries(FRAMEWORK_ALIASES).find(([, v]) => v === fw.dep);
  return alias ? alias[0] : fw.dep;
});

const FALLBACK_KEY = "CLERK_PUBLISHABLE_KEY";
const FALLBACK_SECRET_KEY = "CLERK_SECRET_KEY";

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
  if (!allDeps) {
    log.debug(`framework: no package.json at ${cwd} or unable to parse`);
    return null;
  }

  for (const fw of FRAMEWORK_MAP) {
    if (fw.dep in allDeps) {
      log.debug(`framework: detected "${fw.name}" via dependency "${fw.dep}"`);
      return fw;
    }
  }

  log.debug(`framework: no match in ${cwd}/package.json dependencies`);
  return null;
}

export async function detectPublishableKeyName(cwd: string): Promise<string> {
  const fw = await detectFramework(cwd);
  return fw?.envVar ?? FALLBACK_KEY;
}

export async function detectSecretKeyName(cwd: string): Promise<string> {
  const fw = await detectFramework(cwd);
  return fw?.secretKeyEnvVar ?? FALLBACK_SECRET_KEY;
}

const FALLBACK_ENV_FILE = ".env.local";

export async function detectEnvFile(cwd: string): Promise<".env" | ".env.local"> {
  const fw = await detectFramework(cwd);
  return fw?.envFile ?? FALLBACK_ENV_FILE;
}
