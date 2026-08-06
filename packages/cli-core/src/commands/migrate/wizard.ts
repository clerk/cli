/**
 * The interactive path behind a bare `clerk migrate`.
 *
 * Ported from the standalone migration-tool's `src/migrate/cli.ts` interactive
 * flow. Every answer is pre-filled from the previous run's `.settings`, so a
 * repeat migration is mostly pressing enter.
 *
 * Agent mode never reaches here — `run` raises a usage error naming the flags
 * instead, because an agent cannot answer a prompt.
 */

import { throwUsageError } from "../../lib/errors.ts";
import { select } from "../../lib/listage.ts";
import { log } from "../../lib/log.ts";
import { text } from "../../lib/prompts.ts";
import { loadSettings } from "./lib/settings.ts";
import { fileExists, getFileType } from "./lib/transform.ts";
import { transformers } from "./transformers/registry.ts";
import type { FirebaseHashConfig } from "./types.ts";

export type WizardResult = {
  transformer: string;
  file: string;
  firebaseHashConfig?: FirebaseHashConfig;
};

/** Trims a description down to a single readable hint line. */
function hint(description: string): string {
  const firstSentence = description.split(". ")[0] ?? description;
  return firstSentence.length > 96 ? `${firstSentence.slice(0, 93)}...` : firstSentence;
}

async function pickTransformer(defaultKey: string | undefined): Promise<string> {
  // Built from the registry, so a new platform appears here with no second
  // place to update.
  return select<string>({
    message: "Which platform are you migrating from?",
    choices: transformers.map((entry) => ({
      name: entry.label,
      value: entry.key,
      description: hint(entry.description),
    })),
    default: defaultKey && transformers.some((t) => t.key === defaultKey) ? defaultKey : undefined,
  });
}

async function askFile(defaultFile: string | undefined): Promise<string> {
  return text({
    message: "Path to the exported user file (JSON or CSV)",
    default: defaultFile,
    validate: (value) => {
      const file = value?.trim();
      if (!file) return "A file path is required";
      if (!fileExists(file)) return `File not found: ${file}`;
      if (!getFileType(file)) return "Provide a .json or .csv file";
      return undefined;
    },
  });
}

/**
 * Collects Firebase's four hash parameters.
 *
 * Asked as a set because a partial set produces a digest that verifies against
 * nothing. Pressing enter through all four leaves the config unset, which is
 * correct for an export with no password hashes.
 */
async function askFirebaseHashConfig(
  saved: FirebaseHashConfig | undefined,
): Promise<FirebaseHashConfig | undefined> {
  log.info(
    "Firebase password hashes need the project's hash parameters. Find them in the Firebase console under Authentication → Users → (⋮) → Password hash parameters.",
  );
  log.info(dimIfSaved(saved));

  const signerKey = (
    await text({
      message: "base64 signer key (leave blank if this export has no passwords)",
      default: saved?.base64_signer_key,
    })
  ).trim();
  if (!signerKey) return undefined;

  const saltSeparator = (
    await text({
      message: "base64 salt separator",
      default: saved?.base64_salt_separator,
      validate: (value) => (value?.trim() ? undefined : "Required alongside the signer key"),
    })
  ).trim();

  const rounds = await askNumber("rounds", saved?.rounds);
  const memCost = await askNumber("mem cost", saved?.mem_cost);

  return {
    base64_signer_key: signerKey,
    base64_salt_separator: saltSeparator,
    rounds,
    mem_cost: memCost,
  };
}

function dimIfSaved(saved: FirebaseHashConfig | undefined): string {
  return saved
    ? "Saved parameters found — press enter to reuse them."
    : "Leave the signer key blank if this export carries no passwords.";
}

async function askNumber(label: string, defaultValue: number | undefined): Promise<number> {
  const answer = await text({
    message: label,
    default: defaultValue === undefined ? undefined : String(defaultValue),
    validate: (value) => {
      const parsed = Number(value?.trim());
      return Number.isInteger(parsed) && parsed > 0 ? undefined : "Enter a positive whole number";
    },
  });
  return Number(answer.trim());
}

/**
 * Fills in whichever of transformer and file were not passed as flags.
 *
 * @param provided - Flags the caller already supplied; those are not asked for.
 */
export async function runWizard(provided: {
  transformer?: string;
  file?: string;
  firebaseHashConfig?: FirebaseHashConfig;
}): Promise<WizardResult> {
  const saved = loadSettings();

  const transformer = provided.transformer ?? (await pickTransformer(saved.key));
  const file = provided.file ?? (await askFile(saved.file));

  let firebaseHashConfig = provided.firebaseHashConfig;
  if (transformer === "firebase" && !firebaseHashConfig) {
    firebaseHashConfig = await askFirebaseHashConfig(saved.firebaseHashConfig);
  }

  return { transformer, file, ...(firebaseHashConfig ? { firebaseHashConfig } : {}) };
}

/**
 * The error an agent gets instead of a prompt.
 *
 * Names exactly the flags that are missing, so the caller can retry without
 * guessing which of the two it forgot.
 */
export function throwAgentFlagsRequired(missing: { transformer: boolean; file: boolean }): never {
  const flags = [
    missing.transformer ? "--transformer <platform>" : undefined,
    missing.file ? "--file <path>" : undefined,
  ].filter(Boolean);

  throwUsageError(
    `\`clerk migrate\` is interactive and cannot prompt in agent mode. Pass ${flags.join(" and ")}.`,
    undefined,
    undefined,
    [
      {
        command: `clerk migrate run -y --transformer ${transformers[0]?.key ?? "clerk"} --file users.json`,
        description: "Run non-interactively",
      },
    ],
  );
}
