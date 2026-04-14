/**
 * Global installer detection.
 *
 * Detects how the CLI was installed globally — npm, bun, pnpm, yarn, or
 * Homebrew — so the update command can use the correct update mechanism.
 *
 * Detection priority:
 *  1. `npm_config_user_agent` env var (set when invoked via a PM script runner)
 *  2. `process.execPath` — the real, symlink-resolved binary path:
 *     a. Contains `/Cellar/clerk/` → Homebrew
 *     b. Matches a PM's global prefix → that PM
 *  3. Falls back to npm
 *
 * This module also provides `globalInstallCommand()` for building
 * user-facing install/update hints.
 */

import { realpath } from "node:fs/promises";
import { log } from "./log.ts";
import { UPDATE_PACKAGE_NAME } from "./constants.ts";

// ── Types ────────────────────────────────────────────────────────────────────

/** How the CLI was installed globally. */
export type Installer = "npm" | "bun" | "pnpm" | "yarn" | "homebrew";

// ── Stage 1: npm_config_user_agent ───────────────────────────────────────────

export function detectFromUserAgent(): Installer | null {
  const ua = process.env.npm_config_user_agent ?? "";
  if (ua.startsWith("bun/")) return "bun";
  if (ua.startsWith("pnpm/")) return "pnpm";
  if (ua.startsWith("yarn/")) return "yarn";
  if (ua.startsWith("npm/")) return "npm";
  return null;
}

// ── Stage 2a: Homebrew ───────────────────────────────────────────────────────

export function isHomebrewPath(execPath: string): boolean {
  // Matches:
  //   /opt/homebrew/Cellar/clerk/...         (macOS Apple Silicon)
  //   /usr/local/Cellar/clerk/...            (macOS Intel)
  //   /home/linuxbrew/.linuxbrew/Cellar/clerk/... (Linuxbrew)
  return /\/Cellar\/clerk\//.test(execPath);
}

// ── Stage 2b: PM prefix matching ─────────────────────────────────────────────

async function safeRealpath(p: string): Promise<string> {
  try {
    return await realpath(p);
  } catch {
    return p;
  }
}

async function queryPmPrefix(pm: "npm" | "bun" | "pnpm" | "yarn"): Promise<string | null> {
  try {
    let result;
    switch (pm) {
      case "bun":
        result = await Bun.$`bun pm bin -g`.quiet().nothrow();
        break;
      case "pnpm":
        result = await Bun.$`pnpm root -g`.quiet().nothrow();
        break;
      case "yarn":
        result = await Bun.$`yarn global dir`.quiet().nothrow();
        break;
      default: {
        result = await Bun.$`npm prefix -g`.quiet().nothrow();
        if (result.exitCode !== 0) return null;
        const prefix = result.stdout.toString().trim();
        if (!prefix) return null;
        return await safeRealpath(`${prefix}/lib/node_modules`);
      }
    }
    if (result.exitCode !== 0) return null;
    const dir = result.stdout.toString().trim();
    if (!dir) return null;
    return await safeRealpath(dir);
  } catch {
    return null;
  }
}

async function matchPmFromExecPath(execPath: string): Promise<Installer | null> {
  const pms = ["bun", "pnpm", "yarn", "npm"] as const;
  const results = await Promise.allSettled(pms.map((pm) => queryPmPrefix(pm)));

  for (const [i, result] of results.entries()) {
    if (result.status !== "fulfilled" || !result.value) continue;
    const pm = pms[i];
    if (pm && execPath.startsWith(result.value + "/")) return pm;
  }
  return null;
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Detect the installer that installed the CLI globally.
 *
 * Uses `npm_config_user_agent` when available (highest confidence), then
 * inspects `process.execPath` to identify Homebrew or match against PM
 * global directories. `process.execPath` resolves through symlinks
 * automatically, so a symlink at `~/.local/bin/clerk` pointing to a
 * Homebrew Cellar or PM global dir is correctly attributed.
 */
export async function detectInstaller(): Promise<Installer> {
  // Stage 1: npm_config_user_agent
  const fromUA = detectFromUserAgent();
  if (fromUA) return fromUA;

  // Stage 2: process.execPath
  const execPath = process.execPath;

  // 2a: Homebrew — Cellar path is distinctive and unambiguous
  if (isHomebrewPath(execPath)) return "homebrew";

  // 2b: Match against PM global directories (parallel queries)
  try {
    const pm = await matchPmFromExecPath(execPath);
    if (pm) return pm;
  } catch (error) {
    log.debug(`PM prefix detection failed: ${error}`);
  }

  // Stage 3: Fallback
  return "npm";
}

/**
 * Returns a human-readable install/update command for the given installer.
 */
export function globalInstallCommand(installer: Installer, packageSpec: string): string {
  switch (installer) {
    case "bun":
      return `bun add -g ${packageSpec}`;
    case "pnpm":
      return `pnpm add -g ${packageSpec}`;
    case "yarn":
      return `yarn global add ${packageSpec}`;
    case "homebrew":
      return `brew upgrade ${UPDATE_PACKAGE_NAME}`;
    default:
      return `npm install -g ${packageSpec}`;
  }
}
