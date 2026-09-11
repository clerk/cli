/**
 * What `clerk migrate settings` can show and change.
 *
 * Two stores, split by what the value is rather than by which command wrote it:
 *
 * - **config** — what this project last migrated. Not secret, not per-machine
 *   secret material, and useless to anyone but the CLI, so it lives in the
 *   CLI's own config file keyed by project.
 * - **env** — credentials. They go to `.env.clerk-migrate`, which is
 *   gitignored on write and hand-editable, because a credential belongs
 *   somewhere the user can rotate it without the CLI's help.
 *
 * A setting is listed here exactly once; `list`, `set` and `clear` all read
 * this table rather than each keeping their own idea of what exists.
 */

import { REDACTED } from "../../../lib/constants.ts";

export type SettingStore = "config" | "env";

export interface SettingDef {
  /**
   * What the user types: `clerk migrate settings set <name> <value>`.
   *
   * Kebab-case, and identical to the `migrate import` flag it backs. A setting and
   * its flag are the same knob reached two ways, so `firebase-signer-key` here
   * and `--firebase-signer-key` there must not drift into two spellings the
   * user has to learn separately. Sentence-case prose belongs in
   * `description`, which is what the list renders alongside it.
   */
  name: string;
  store: SettingStore;
  description: string;
  /**
   * The environment variable this setting is read from at run time.
   *
   * Required for an `env` setting, which lives nowhere else. A `config`
   * setting may also declare one, meaning "remembered here, but an environment
   * value wins" — `log-dir` is that shape, so an operator can pin a directory
   * per shell without disturbing what the project remembers.
   */
  envVar?: string;
  /**
   * Other variables accepted for the same setting, read only when
   * {@link envVar} is absent.
   *
   * Firebase hands its four scrypt parameters over as `base64_signer_key`,
   * `rounds` and friends, and every guide — including Clerk's own standalone
   * migration script — tells the reader to paste them into `.env` under those
   * names. Someone who did that has the values the CLI needs, spelled the way
   * the source platform spells them, and a listing that reports "not set" is
   * wrong about the project rather than strict about it.
   *
   * Prefixed names still win, and the listing names the variable it read, so a
   * generic `ROUNDS` that means something else in the app is visible rather
   * than silent.
   */
  envAliases?: string[];
  /** For `config` settings, the key on the saved migration entry. */
  configKey?: "transformer" | "file" | "skipUnsupportedProviders" | "logDir";
  /** Redact when displaying — the value is a credential. */
  secret?: boolean;
  /** Reject a value the run would only fail on later. */
  validate?: (value: string) => string | undefined;
}

const positiveInteger = (value: string): string | undefined => {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? undefined : "Expected a positive whole number";
};

const boolean = (value: string): string | undefined =>
  ["true", "false"].includes(value) ? undefined : "Expected true or false";

const path = (value: string): string | undefined =>
  value.trim().length > 0 ? undefined : "Expected a directory path";

export const SETTINGS: SettingDef[] = [
  {
    name: "transformer",
    store: "config",
    configKey: "transformer",
    description: "Source platform the export came from",
  },
  {
    name: "file",
    store: "config",
    configKey: "file",
    description: "Export file to import users from",
  },
  {
    name: "skip-unsupported-providers",
    store: "config",
    configKey: "skipUnsupportedProviders",
    description: "Skip users with no provider enabled in Clerk (Supabase)",
    validate: boolean,
  },
  {
    name: "log-dir",
    store: "config",
    configKey: "logDir",
    envVar: "CLERK_MIGRATE_LOG_DIR",
    description: "Directory migration logs are written to",
    validate: path,
  },
  {
    name: "firebase-signer-key",
    store: "env",
    envVar: "CLERK_FIREBASE_SIGNER_KEY",
    envAliases: ["FIREBASE_BASE64_SIGNER_KEY", "BASE64_SIGNER_KEY"],
    description: "Firebase base64 signer key",
    secret: true,
  },
  {
    name: "firebase-salt-separator",
    store: "env",
    envVar: "CLERK_FIREBASE_SALT_SEPARATOR",
    envAliases: ["FIREBASE_BASE64_SALT_SEPARATOR", "BASE64_SALT_SEPARATOR"],
    description: "Firebase base64 salt separator",
  },
  {
    name: "firebase-rounds",
    store: "env",
    envVar: "CLERK_FIREBASE_ROUNDS",
    envAliases: ["FIREBASE_ROUNDS", "ROUNDS"],
    description: "Firebase scrypt rounds",
    validate: positiveInteger,
  },
  {
    name: "firebase-mem-cost",
    store: "env",
    envVar: "CLERK_FIREBASE_MEM_COST",
    envAliases: ["FIREBASE_MEM_COST", "MEM_COST"],
    description: "Firebase scrypt memory cost",
    validate: positiveInteger,
  },
];

export const SETTING_NAMES = SETTINGS.map((setting) => setting.name);

export function findSetting(name: string): SettingDef | undefined {
  return SETTINGS.find((setting) => setting.name === name);
}

/** Levenshtein distance, iterative over a single row. */
function distance(a: string, b: string): number {
  const row = Array.from({ length: b.length + 1 }, (_, i) => i);

  for (let i = 1; i <= a.length; i++) {
    let diagonal = row[0] as number;
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const above = row[j] as number;
      row[j] = Math.min(
        above + 1,
        (row[j - 1] as number) + 1,
        diagonal + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
      diagonal = above;
    }
  }

  return row[b.length] as number;
}

/**
 * The setting a misspelling was probably reaching for.
 *
 * Every setting name is a compound of short words — `log-dir`, `firebase-mem-cost`
 * — so the misses that matter are a pluralised segment or a transposed pair,
 * not a different word entirely. One edit per three characters keeps
 * `logs-dir` pointing at `log-dir` without letting an unrelated name match
 * something and send the reader off after it.
 *
 * @returns The closest name within that budget, or `undefined` when nothing is
 *   close enough to be worth naming.
 */
export function suggestSettingName(name: string): string | undefined {
  const budget = Math.max(1, Math.floor(name.length / 3));

  let best: { name: string; distance: number } | undefined;
  for (const candidate of SETTING_NAMES) {
    const gap = distance(name, candidate);
    if (gap <= budget && (!best || gap < best.distance)) best = { name: candidate, distance: gap };
  }

  return best?.name;
}

/**
 * Every variable an `env` setting answers to, highest priority first.
 *
 * One list, read by both the listing and the run, so `clerk migrate settings`
 * can never show a value the import would ignore.
 */
export function envNames(setting: SettingDef): string[] {
  return [setting.envVar as string, ...(setting.envAliases ?? [])];
}

/**
 * The display value for a setting: withheld entirely when it is a credential.
 *
 * {@link REDACTED} is what `clerk users create --dry-run` already prints for a
 * password, so a credential reads the same wherever the CLI declines to show
 * one. Head-and-tail (`aVer…3456`) would say *which* key is set, but the source
 * column answers that, and a partial value is one the reader has to recognise
 * as partial.
 */
export function displayValue(setting: SettingDef, value: string): string {
  return setting.secret ? REDACTED : value;
}
