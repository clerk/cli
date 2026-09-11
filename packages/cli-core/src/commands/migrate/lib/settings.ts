/**
 * What this project last migrated, and with which transformer.
 *
 * Kept in the CLI's own config file under `migrations`, keyed by project — the
 * same shape `clerk webhooks listen` files its relay token under. An earlier
 * version wrote a `.settings` file into the user's cwd instead, which the CLI
 * cannot gitignore on the user's behalf and which put migration state inside
 * the repository being migrated.
 *
 * Both halves fail silently: an unreadable or unwritable config only costs the
 * user a remembered default, so it must not take the run down with it.
 */

import {
  getMigrationEntry,
  getProjectKey,
  setMigrationEntry,
  type MigrationEntry,
} from "../../../lib/config.ts";
import { log } from "../../../lib/log.ts";

/** Reads saved settings, or `{}` when absent or unreadable. */
export async function loadSettings(): Promise<MigrationEntry> {
  try {
    return (await getMigrationEntry(await getProjectKey(process.cwd()))) ?? {};
  } catch (error) {
    log.debug(`config: could not read migration settings — ${error}`);
    return {};
  }
}

/** Persists settings for the next run in this project. */
export async function saveSettings(settings: MigrationEntry): Promise<void> {
  try {
    await setMigrationEntry(await getProjectKey(process.cwd()), settings);
  } catch (error) {
    log.debug(`config: could not save migration settings — ${error}`);
  }
}
