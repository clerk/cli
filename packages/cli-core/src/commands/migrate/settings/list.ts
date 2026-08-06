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
    description: setting.description,
    // Redacted here too: `--json` is what gets piped into a log or a ticket.
    value: value === undefined ? null : displayValue(setting, value),
    set: value !== undefined,
    secret: Boolean(setting.secret),
    source: source ?? null,
  }));
}

/**
 * Pads to a visible width, then colours.
 *
 * Colouring first and padding after would count the ANSI escape bytes towards
 * the width and pull every later column left by however many they took.
 */
function column(text: string, width: number, paint: (value: string) => string): string {
  return paint(text) + " ".repeat(Math.max(0, width - text.length));
}

export async function list(options: SettingsListOptions = {}): Promise<void> {
  const resolved = await resolveAll();

  if (options.json) {
    log.data(JSON.stringify(toJson(resolved), null, 2));
    return;
  }

  const cells = resolved.map(({ setting, value, source }) => ({
    setting,
    name: setting.name,
    value: value === undefined ? "—" : displayValue(setting, value),
    unset: value === undefined,
    source: source ?? "not set",
  }));

  const width = (header: string, pick: (cell: (typeof cells)[number]) => string) =>
    Math.max(header.length, ...cells.map((cell) => pick(cell).length)) + 2;

  const nameWidth = width("SETTING", (c) => c.name);
  const valueWidth = width("VALUE", (c) => c.value);
  const sourceWidth = width("SOURCE", (c) => c.source);

  log.info(
    column("SETTING", nameWidth, dim) +
      column("VALUE", valueWidth, dim) +
      column("SOURCE", sourceWidth, dim) +
      dim("DESCRIPTION"),
  );

  for (const cell of cells) {
    log.info(
      column(cell.name, nameWidth, cyan) +
        column(cell.value, valueWidth, cell.unset ? dim : (value) => value) +
        column(cell.source, sourceWidth, dim) +
        dim(cell.setting.description),
    );
  }

  log.blank();
  log.info(dim("Credentials are shown redacted. `clerk migrate settings set <name> <value>`."));
}
