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

export type SettingStore = "config" | "env";

export interface SettingDef {
  /** What the user types: `clerk migrate settings set <name> <value>`. */
  name: string;
  store: SettingStore;
  description: string;
  /** For `env` settings, the variable read at run time. */
  envVar?: string;
  /** For `config` settings, the key on the saved migration entry. */
  configKey?: "transformer" | "file" | "skipUnsupportedProviders";
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

export const SETTINGS: SettingDef[] = [
  {
    name: "transformer",
    store: "config",
    configKey: "transformer",
    description: "Source platform the last run imported from",
  },
  {
    name: "file",
    store: "config",
    configKey: "file",
    description: "Export file the last run imported",
  },
  {
    name: "skip-unsupported-providers",
    store: "config",
    configKey: "skipUnsupportedProviders",
    description: "Supabase: skip users whose only social provider is disabled in Clerk",
    validate: boolean,
  },
  {
    name: "firebase-signer-key",
    store: "env",
    envVar: "CLERK_FIREBASE_SIGNER_KEY",
    description: "Firebase base64 signer key",
    secret: true,
  },
  {
    name: "firebase-salt-separator",
    store: "env",
    envVar: "CLERK_FIREBASE_SALT_SEPARATOR",
    description: "Firebase base64 salt separator",
  },
  {
    name: "firebase-rounds",
    store: "env",
    envVar: "CLERK_FIREBASE_ROUNDS",
    description: "Firebase scrypt rounds",
    validate: positiveInteger,
  },
  {
    name: "firebase-mem-cost",
    store: "env",
    envVar: "CLERK_FIREBASE_MEM_COST",
    description: "Firebase scrypt memory cost",
    validate: positiveInteger,
  },
];

export const SETTING_NAMES = SETTINGS.map((setting) => setting.name);

export function findSetting(name: string): SettingDef | undefined {
  return SETTINGS.find((setting) => setting.name === name);
}

/**
 * Shows enough of a credential to recognise it, never enough to use it.
 *
 * Anything short enough that head-and-tail would leak most of it is masked
 * whole: a 10-character key shown as `abcd…wxyz` has given away 8 of them.
 */
export function redact(value: string): string {
  if (value.length < 16) return "•".repeat(8);
  return `${value.slice(0, 4)}…${value.slice(-4)}`;
}

/** The display value for a setting: redacted when it is a credential. */
export function displayValue(setting: SettingDef, value: string): string {
  return setting.secret ? redact(value) : value;
}
