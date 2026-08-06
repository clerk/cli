/**
 * The cwd-relative `.settings` file: what this directory last migrated, and
 * with which transformer.
 *
 * Ported from the standalone migration-tool's `src/lib/settings.ts`. Kept out
 * of `~/.config/clerk/config.json` on purpose — that file is keyed by linked
 * project identity, not by "which export file am I working through".
 *
 * Both halves fail silently: a missing, unreadable or unwritable `.settings`
 * only costs the user a remembered default.
 */

import fs from "node:fs";
import path from "node:path";
import type { Settings } from "../types.ts";

const SETTINGS_FILE = ".settings";

function settingsPath(): string {
  return path.join(process.cwd(), SETTINGS_FILE);
}

/** Reads saved settings, or `{}` when absent or corrupt. */
export function loadSettings(): Settings {
  try {
    const file = settingsPath();
    if (fs.existsSync(file)) {
      return JSON.parse(fs.readFileSync(file, "utf-8")) as Settings;
    }
  } catch {
    // Corrupt or unreadable settings are indistinguishable from none.
  }
  return {};
}

/** Persists settings for the next run in this directory. */
export function saveSettings(settings: Settings): void {
  try {
    fs.writeFileSync(settingsPath(), JSON.stringify(settings, null, 2));
  } catch {
    // Read-only cwd; the run itself is unaffected.
  }
}
