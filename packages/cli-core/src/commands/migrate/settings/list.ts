/**
 * `clerk migrate settings` — what a run in this project would pick up, and
 * where each value is coming from.
 *
 * The source column is the point. A migration reads from flags, the
 * environment, two of the app's env files and the CLI's config; when a run uses
 * a stale value, the question is never "what is it" but "which of those is
 * winning". Credentials are redacted, so this is safe to paste into an issue.
 *
 * Laid out like the CLI's other listings — `migrate logs list` and `migrate
 * transformers list`: a line or two of orientation, the table, then a count.
 * It closes with next steps, the way `mcp list` and `whoami` do, because a
 * listing is where someone lands before they know what to type. Those are for
 * humans; the full command surface stays in `--help`.
 */

import { cyan, dim } from "../../../lib/color.ts";
import { log } from "../../../lib/log.ts";
import { NEXT_STEPS, printNextSteps } from "../../../lib/next-steps.ts";
import { findMigrateEnvValue } from "../lib/env-file.ts";
import { loadSettings } from "../lib/settings.ts";
import { displayValue, envNames, SETTINGS, type SettingDef } from "./registry.ts";

export type SettingsListOptions = {
  json?: boolean;
};

interface ResolvedSetting {
  setting: SettingDef;
  value?: string;
  source?: string;
}

/**
 * Names the variable as well as the file when an alias supplied the value.
 *
 * `.env.local` alone would be a half-answer for a setting that has four
 * accepted spellings: the reader has to know *which* line in that file the run
 * is reading before they can change it. An exported variable already carries
 * its name in `source`.
 */
function describeSource(setting: SettingDef, located: { name: string; source: string }): string {
  if (located.name === setting.envVar || located.source.startsWith(located.name)) {
    return located.source;
  }
  return `${located.source} (${located.name})`;
}

async function resolveAll(): Promise<ResolvedSetting[]> {
  const saved = await loadSettings();

  return Promise.all(
    SETTINGS.map(async (setting): Promise<ResolvedSetting> => {
      if (setting.store === "config") {
        // `log-dir` is remembered in the config but yields to an environment
        // value, so the environment has to be checked first here too — a
        // listing that shows the remembered path while the run reads another
        // is the one thing the source column exists to prevent.
        if (setting.envVar) {
          const located = await findMigrateEnvValue(envNames(setting));
          if (located) {
            return { setting, value: located.value, source: describeSource(setting, located) };
          }
        }

        const value = saved[setting.configKey as keyof typeof saved];
        return value === undefined
          ? { setting }
          : { setting, value: String(value), source: "clerk config" };
      }

      const located = await findMigrateEnvValue(envNames(setting));
      return located
        ? { setting, value: located.value, source: describeSource(setting, located) }
        : { setting };
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

  // An unset value leaves the column empty rather than filling it with a
  // placeholder: the source column already reads "not set" on the same row, and
  // an empty cell is what makes the settings that do have a value stand out.
  const cells = resolved.map(({ setting, value, source }) => ({
    setting,
    name: setting.name,
    value: value === undefined ? "" : displayValue(setting, value),
    unset: value === undefined,
    source: source ?? "not set",
  }));

  const width = (header: string, pick: (cell: (typeof cells)[number]) => string) =>
    Math.max(header.length, ...cells.map((cell) => pick(cell).length)) + 2;

  const nameWidth = width("SETTING", (c) => c.name);
  const valueWidth = width("VALUE", (c) => c.value);
  const sourceWidth = width("SOURCE", (c) => c.source);

  log.info("A migration run in this directory picks these up unless a flag overrides them.");
  log.info("Each setting is named after the `clerk migrate import` flag it stands in for.");
  log.blank();

  log.info(
    column("SETTING", nameWidth, dim) +
      column("VALUE", valueWidth, dim) +
      column("SOURCE", sourceWidth, dim) +
      dim("DESCRIPTION"),
  );

  for (const cell of cells) {
    log.info(
      column(cell.name, nameWidth, cyan) +
        column(cell.value, valueWidth, (value) => value) +
        column(cell.source, sourceWidth, dim) +
        dim(cell.setting.description),
    );
  }

  const set = cells.filter((cell) => !cell.unset).length;
  log.blank();
  log.info(`${set} of ${cells.length} settings set. Credentials are shown redacted.`);
  log.blank();

  printNextSteps(NEXT_STEPS.MIGRATE_SETTINGS);
}
