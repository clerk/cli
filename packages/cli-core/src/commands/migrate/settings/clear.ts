/**
 * `clerk migrate settings clear` — forget this project's migration settings.
 *
 * Clears both stores by default. The credentials half is the reason this
 * command exists: after a migration finishes, a Firebase signer key sitting in
 * the repo has no further use, and "delete the file yourself" is a step people
 * skip.
 *
 * `migrate delete` reads the saved transformer and file to know what to undo,
 * so clearing is confirmed unless `-y` — an operator who clears and then wants
 * to undo has no record left to undo from.
 */

import { throwUserAbort } from "../../../lib/errors.ts";
import { log } from "../../../lib/log.ts";
import { confirm } from "../../../lib/prompts.ts";
import { isAgent, isHuman } from "../../../mode.ts";
import { clearMigrateEnvValues, MIGRATE_ENV_FILE } from "../lib/env-file.ts";
import { loadSettings, saveSettings } from "../lib/settings.ts";
import { SETTINGS } from "./registry.ts";

export type SettingsClearOptions = {
  yes?: boolean;
};

const ENV_VARS = SETTINGS.filter((s) => s.store === "env").map((s) => s.envVar as string);

export async function clear(options: SettingsClearOptions = {}): Promise<void> {
  const saved = await loadSettings();
  const hadConfig = Object.keys(saved).length > 0;

  if (!options.yes && isHuman() && !isAgent()) {
    if (hadConfig && saved.file) {
      log.warn(
        `\`clerk migrate delete\` uses the saved file (${saved.file}) to identify the users the last run created. ` +
          "Clearing it leaves nothing to undo from.",
      );
    }
    const proceed = await confirm({
      message: "Clear this project's migration settings?",
      default: false,
    });
    if (!proceed) throwUserAbort();
  }

  if (hadConfig) await saveSettings({});
  const dropped = await clearMigrateEnvValues(ENV_VARS);

  if (!hadConfig && dropped.length === 0) {
    log.info("No migration settings to clear for this project.");
    return;
  }

  if (hadConfig) log.success("Cleared the saved transformer and file.");
  if (dropped.length > 0) {
    log.success(`Removed ${dropped.length} credential(s) from ${MIGRATE_ENV_FILE}.`);
  }
}
