/**
 * Framework detection for determining the correct Clerk SDK and env var name.
 * Reads package.json to identify the project's framework.
 */

import { join } from "node:path";
import { readdir } from "node:fs/promises";
import { log } from "./log.ts";

/** Where the framework's Clerk SDK is published. Drives how `clerk init`
 *  installs the SDK: npm frameworks run the package manager, native
 *  ecosystems (Swift Package Manager, Gradle) print manual install steps. */
export type FrameworkEcosystem = "npm" | "swift" | "gradle";

export interface FrameworkInfo {
  /** npm dependency that identifies the framework, or a stable id for
   *  non-npm platforms (e.g. "ios", "android"). Also the `--framework` value. */
  dep: string;
  name: string;
  sdk: string;
  /** Override the install specifier when it differs from the package name (e.g. pinned version). */
  sdkInstall?: string;
  envVar: string;
  /** Override for secret key env var name. Defaults to CLERK_SECRET_KEY when omitted. */
  secretKeyEnvVar?: string;
  /** Preferred env file for secrets when the project has none yet. Frameworks
   *  with a `.env.local` convention use it (always gitignored, per-machine
   *  overrides); frameworks without that convention fall back to `.env`. */
  envFile: ".env" | ".env.local";
  /** When true, the framework's Clerk SDK supports keyless mode (auto-generated
   *  temporary dev keys). Frameworks without keyless support require API keys
   *  and must authenticate during `clerk init`. */
  supportsKeyless?: boolean;
  /** SDK distribution ecosystem. Defaults to "npm" when omitted. */
  ecosystem?: FrameworkEcosystem;
}

export function isNpmFramework(fw: Pick<FrameworkInfo, "ecosystem">): boolean {
  return (fw.ecosystem ?? "npm") === "npm";
}

// Order matters: more specific frameworks first (e.g. next before react, nuxt before vue)
export const FRAMEWORK_MAP: FrameworkInfo[] = [
  {
    dep: "next",
    name: "Next.js",
    sdk: "@clerk/nextjs",
    envVar: "NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY",
    envFile: ".env.local",
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

type NativeFrameworkEntry = FrameworkInfo & {
  /** Marker paths (relative to cwd) that identify the platform. A leading
   *  "*" matches any directory-entry name with that suffix (e.g. "*.xcodeproj"). */
  markers: string[];
};

// Native mobile platforms have no package.json, so they are detected via
// project marker files instead of npm dependencies. Only consulted when no
// npm framework matches (an Expo project with prebuilt ios/ + android/ dirs
// must still detect as Expo).
export const NATIVE_FRAMEWORK_MAP: NativeFrameworkEntry[] = [
  {
    dep: "ios",
    name: "iOS (Swift)",
    sdk: "ClerkKit",
    envVar: "CLERK_PUBLISHABLE_KEY",
    envFile: ".env",
    ecosystem: "swift",
    // Xcode project/workspace bundles only — a bare Package.swift could be a
    // server-side Swift or library package, which the Clerk iOS SDK doesn't target.
    markers: ["*.xcodeproj", "*.xcworkspace"],
  },
  {
    dep: "android",
    name: "Android (Kotlin)",
    sdk: "com.clerk:clerk-android-ui",
    envVar: "CLERK_PUBLISHABLE_KEY",
    envFile: ".env",
    ecosystem: "gradle",
    // AndroidManifest.xml is the unambiguous signal — build.gradle alone would
    // also match non-Android JVM projects (e.g. Spring, Kotlin backends).
    markers: ["app/src/main/AndroidManifest.xml", "src/main/AndroidManifest.xml"],
  },
];

const ALL_FRAMEWORKS: FrameworkInfo[] = [...FRAMEWORK_MAP, ...NATIVE_FRAMEWORK_MAP];

const FRAMEWORK_ALIASES: Record<string, string> = {
  "tanstack-start": "@tanstack/react-start",
  javascript: "vite",
  js: "vite",
};

export function lookupFramework(name: string): FrameworkInfo | null {
  const dep = FRAMEWORK_ALIASES[name] ?? name;
  return ALL_FRAMEWORKS.find((fw) => fw.dep === dep) ?? null;
}

export const FRAMEWORK_NAMES = ALL_FRAMEWORKS.map((fw) => {
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

async function matchesMarker(cwd: string, marker: string): Promise<boolean> {
  if (!marker.startsWith("*")) {
    return Bun.file(join(cwd, marker)).exists();
  }

  const suffix = marker.slice(1);
  try {
    // Wildcard markers identify bundle directories (*.xcodeproj/*.xcworkspace)
    // — a stray plain file with that suffix is not a real project marker.
    const entries = await readdir(cwd, { withFileTypes: true });
    return entries.some((entry) => entry.isDirectory() && entry.name.endsWith(suffix));
  } catch {
    return false;
  }
}

async function detectNativeFramework(cwd: string): Promise<FrameworkInfo | null> {
  for (const fw of NATIVE_FRAMEWORK_MAP) {
    const results = await Promise.all(fw.markers.map((marker) => matchesMarker(cwd, marker)));
    const matched = fw.markers.find((_, i) => results[i]);
    if (matched !== undefined) {
      log.debug(`framework: detected "${fw.name}" via marker "${matched}"`);
      return fw;
    }
  }
  return null;
}

export async function detectFramework(cwd: string): Promise<FrameworkInfo | null> {
  const allDeps = await readDeps(cwd);

  if (allDeps) {
    for (const fw of FRAMEWORK_MAP) {
      if (fw.dep in allDeps) {
        log.debug(`framework: detected "${fw.name}" via dependency "${fw.dep}"`);
        return fw;
      }
    }
  } else {
    log.debug(`framework: no package.json at ${cwd} or unable to parse`);
  }

  const native = await detectNativeFramework(cwd);
  if (native) return native;

  if (allDeps) {
    log.debug(`framework: no match in ${cwd}/package.json dependencies`);
  }
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
