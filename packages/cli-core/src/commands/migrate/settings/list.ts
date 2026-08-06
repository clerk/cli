/**
 * `clerk migrate settings` — what a run in this project would pick up, and
 * where each value is coming from.
 *
 * The source column is the point. A migration reads from flags, the
 * environment, two of the app's env files and the CLI's config; when a run uses
 * a stale value, the question is never "what is it" but "which of those is
 * winning". Credentials are redacted, so this is safe to paste into an issue.
 */

import { cyan, dim } from "../../../lib/color.ts";
import { log } from "../../../lib/log.ts";
import { findMigrateEnvValue } from "../lib/env-file.ts";
import { loadSettings } from "../lib/settings.ts";
import { displayValue, SETTINGS, type SettingDef } from "./registry.ts";

export type SettingsListOptions = {
  json?: boolean;
};

interface ResolvedSetting {
  setting: SettingDef;
  value?: string;
  source?: string;
}

async function resolveAll(): Promise<ResolvedSetting[]> {
  const saved = await loadSettings();

  return Promise.all(
    SETTINGS.map(async (setting): Promise<ResolvedSetting> => {
      if (setting.store === "config") {
        const value = saved[setting.configKey as keyof typeof saved];
        return value === undefined
          ? { setting }
          : { setting, value: String(value), source: "clerk config" };
      }

      const located = await findMigrateEnvValue([setting.envVar as string]);
      return located ? { setting, value: located.value, source: located.source } : { setting };
    }),
  );
}

function toJson(resolved: ResolvedSetting[]) {
  return resolved.map(({ setting, value, source }) => ({
    name: setting.name,
    store: setting.store,
    // Redacted here too: `--json` is what gets piped into a log or a ticket.
    value: value === undefined ? null : displayValue(setting, value),
    set: value !== undefined,
    secret: Boolean(setting.secret),
    source: source ?? null,
  }));
}

export async function list(options: SettingsListOptions = {}): Promise<void> {
  const resolved = await resolveAll();

  if (options.json) {
    log.data(JSON.stringify(toJson(resolved), null, 2));
    return;
  }

  const nameWidth = Math.max(...SETTINGS.map((s) => s.name.length), "SETTING".length) + 2;
  const valueWidth =
    Math.max(
      ...resolved.map(({ setting, value }) =>
        value === undefined ? 1 : displayValue(setting, value).length,
      ),
      "VALUE".length,
    ) + 2;

  log.info(dim("SETTING".padEnd(nameWidth)) + dim("VALUE".padEnd(valueWidth)) + dim("SOURCE"));

  for (const { setting, value, source } of resolved) {
    const shown = value === undefined ? dim("—") : displayValue(setting, value);
    log.info(
      cyan(setting.name.padEnd(nameWidth)) +
        shown.padEnd(valueWidth + (value === undefined ? dim("—").length - 1 : 0)) +
        dim(source ?? "not set"),
    );
  }

  log.blank();
  log.info(dim("Credentials are shown redacted. `clerk migrate settings set <name> <value>`."));
}
