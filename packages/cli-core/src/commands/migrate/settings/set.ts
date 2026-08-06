/**
 * `clerk migrate settings set <name> <value>` — change one setting.
 *
 * Which store it lands in is a property of the setting, not a flag: a
 * credential always goes to `.env.clerk-migrate`, project state always goes to
 * the CLI config. Letting the caller choose would mean a signer key could be
 * put somewhere that is not gitignored.
 */

import { throwUsageError } from "../../../lib/errors.ts";
import { log } from "../../../lib/log.ts";
import { writeMigrateEnvValues } from "../lib/env-file.ts";
import { loadSettings, saveSettings } from "../lib/settings.ts";
import { displayValue, findSetting, SETTING_NAMES } from "./registry.ts";

export async function set(name: string, value: string): Promise<void> {
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

  const invalid = setting.validate?.(value);
  if (invalid) throwUsageError(`Invalid value for ${name}: ${invalid}.`);

  if (setting.store === "env") {
    const file = await writeMigrateEnvValues({ [setting.envVar as string]: value });
    log.success(`Set \`${name}\` in ${file} (gitignored).`);
    return;
  }

  const saved = await loadSettings();
  await saveSettings({
    ...saved,
    [setting.configKey as string]:
      setting.configKey === "skipUnsupportedProviders" ? value === "true" : value,
  });
  log.success(`Set \`${name}\` to ${displayValue(setting, value)} for this project.`);
}
