/**
 * `clerk migrate settings clear [name]` — forget this project's migration
 * settings, or just one of them.
 *
 * Clears both stores when given no name. The credentials half is the reason
 * this command exists: after a migration finishes, a Firebase signer key
 * sitting in the repo has no further use, and "delete the file yourself" is a
 * step people skip.
 *
 * `migrate delete` reads the saved transformer and file to know what to undo,
 * so clearing is confirmed unless `-y` — an operator who clears and then wants
 * to undo has no record left to undo from.
 */

import { throwUsageError, throwUserAbort } from "../../../lib/errors.ts";
import { log } from "../../../lib/log.ts";
import { confirm } from "../../../lib/prompts.ts";
import { isAgent, isHuman } from "../../../mode.ts";
import { clearMigrateEnvValues, MIGRATE_ENV_FILE } from "../lib/env-file.ts";
import { loadSettings, saveSettings } from "../lib/settings.ts";
import type { MigrationEntry } from "../../../lib/config.ts";
import { envNames, findSetting, SETTING_NAMES, SETTINGS } from "./registry.ts";

export type SettingsClearOptions = {
  yes?: boolean;
};

/**
 * Every variable the migration settings own, `log-dir`'s included.
 *
 * Keyed on declaring an `envVar` rather than on `store === "env"`: `log-dir` is
 * remembered in the config but still answers to a variable, and a full clear
 * that left that variable behind would not have cleared the setting.
 */
const ENV_VARS = SETTINGS.filter((s) => s.envVar).map((s) => s.envVar as string);

/**
 * Warns that clearing this is what `migrate delete` reads to find the users the
 * last run created.
 */
function warnAboutUndo(saved: MigrationEntry): void {
  if (!saved.file) return;
  log.warn(
    `\`clerk migrate delete\` uses the saved file (${saved.file}) to identify the users the last run created. ` +
      "Clearing it leaves nothing to undo from.",
  );
}

/**
 * Clears one named setting, leaving the rest of the project's settings alone.
 *
 * Both stores are cleared, because a setting can sit in either and `log-dir`
 * can sit in both. Clearing half of one is worse than clearing none: the
 * command reports the setting gone while the next run still reads it.
 *
 * An `env` value goes under every spelling the setting answers to, not just the
 * prefixed one — dropping `CLERK_FIREBASE_ROUNDS` while `ROUNDS` stayed in the
 * same file would leave the old value winning.
 */
async function clearOne(name: string, options: SettingsClearOptions): Promise<void> {
  const setting = findSetting(name);
  if (!setting) {
    throwUsageError(
      `Unknown setting "${name}". Valid names: ${SETTING_NAMES.join(", ")}.`,
      undefined,
      undefined,
      [
        {
          command: "clerk migrate settings",
          description: "List the settings and their current values",
        },
      ],
    );
  }

  const saved = await loadSettings();

  if (!options.yes && isHuman() && !isAgent()) {
    // Only the file itself is what `migrate delete` cannot do without; the
    // transformer it can be told again.
    if (setting.configKey === "file") warnAboutUndo(saved);
    const proceed = await confirm({ message: `Clear \`${name}\`?`, default: false });
    if (!proceed) throwUserAbort();
  }

  const cleared: string[] = [];

  if (setting.envVar && (await clearMigrateEnvValues(envNames(setting))).length > 0) {
    cleared.push(MIGRATE_ENV_FILE);
  }

  const key = setting.configKey as keyof MigrationEntry | undefined;
  if (key && saved[key] !== undefined) {
    const { [key]: _cleared, ...rest } = saved;
    await saveSettings(rest);
    cleared.push("this project's settings");
  }

  if (cleared.length === 0) {
    log.info(
      `\`${name}\` is not set here. A value coming from the app's own env files or the shell has ` +
        "to be removed there — run `clerk migrate settings` to see which is supplying it.",
    );
    return;
  }

  log.success(`Cleared \`${name}\` from ${cleared.join(" and ")}.`);
}

export async function clear(options: SettingsClearOptions = {}, name?: string): Promise<void> {
  if (name !== undefined) return clearOne(name, options);

  const saved = await loadSettings();
  const hadConfig = Object.keys(saved).length > 0;

  if (!options.yes && isHuman() && !isAgent()) {
    if (hadConfig) warnAboutUndo(saved);
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
    log.success(
      `Removed ${dropped.length} credential${dropped.length === 1 ? "" : "s"} from ${MIGRATE_ENV_FILE}.`,
    );
  }
}
