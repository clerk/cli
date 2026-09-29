/**
 * The interactive path behind a bare `clerk migrate import`.
 *
 * Ported from the standalone migration-tool's `src/migrate/cli.ts` interactive
 * flow.
 *
 * Agent mode never reaches here — `run` raises a usage error naming the flags
 * instead, because an agent cannot answer a prompt.
 */

import { throwUsageError } from "../../lib/errors.ts";
import { select } from "../../lib/listage.ts";
import { log } from "../../lib/log.ts";
import { text } from "../../lib/prompts.ts";
import { resolveFirebaseHashConfig, type FirebaseHashFlags } from "./lib/firebase-hash.ts";
import { fileExists, getFileType } from "./lib/transform.ts";
import { sources } from "./sources/registry.ts";
import type { FirebaseHashConfig } from "./types.ts";

export type WizardResult = {
  source: string;
  file: string;
  firebaseHashConfig?: FirebaseHashConfig;
};

/** Trims a description down to a single readable hint line. */
function hint(description: string): string {
  const firstSentence = description.split(". ")[0] ?? description;
  return firstSentence.length > 96 ? `${firstSentence.slice(0, 93)}...` : firstSentence;
}

async function pickSource(): Promise<string> {
  // Built from the registry, so a new platform appears here with no second
  // place to update.
  return select<string>({
    message: "Which platform are you migrating from?",
    choices: sources.map((entry) => ({
      name: entry.label,
      value: entry.key,
      description: hint(entry.description),
    })),
  });
}

async function askFile(): Promise<string> {
  return text({
    message: "Path to the exported user file (JSON or CSV)",
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
async function askFirebaseHashConfig(): Promise<FirebaseHashConfig | undefined> {
  log.info(
    "Firebase password hashes need the project's hash parameters. Find them in the Firebase console under Authentication → Users → (⋮) → Password hash parameters.",
  );
  log.info("Pass the four --firebase-* flags to skip these prompts on the next run.");

  const signerKey = (
    await text({
      message: "base64 signer key (leave blank if this export has no passwords)",
    })
  ).trim();
  if (!signerKey) return undefined;

  const saltSeparator = (
    await text({
      message: "base64 salt separator",
      validate: (value) => (value?.trim() ? undefined : "Required alongside the signer key"),
    })
  ).trim();

  return {
    base64_signer_key: signerKey,
    base64_salt_separator: saltSeparator,
    rounds: await askNumber("rounds"),
    mem_cost: await askNumber("mem cost"),
  };
}

async function askNumber(label: string): Promise<number> {
  const answer = await text({
    message: label,
    validate: (value) => {
      const parsed = Number(value?.trim());
      return Number.isInteger(parsed) && parsed > 0 ? undefined : "Enter a positive whole number";
    },
  });
  return Number(answer.trim());
}

/**
 * Fills in whichever of source and file were not passed.
 *
 * @param provided - Flags the caller already supplied; those are not asked for.
 */
export async function runWizard(
  provided: {
    source?: string;
    file?: string;
    firebaseHashConfig?: FirebaseHashConfig;
  } & FirebaseHashFlags,
): Promise<WizardResult> {
  const source = provided.source ?? (await pickSource());
  const file = provided.file ?? (await askFile());

  let firebaseHashConfig = provided.firebaseHashConfig;
  if (source === "firebase" && !firebaseHashConfig) {
    firebaseHashConfig =
      resolveFirebaseHashConfig(provided, "firebase") ?? (await askFirebaseHashConfig());
  }

  return { source, file, ...(firebaseHashConfig ? { firebaseHashConfig } : {}) };
}

/**
 * The error an agent gets instead of a prompt.
 *
 * Names exactly the flags that are missing, so the caller can retry without
 * guessing which of the two it forgot.
 */
export function throwAgentFlagsRequired(missing: { source: boolean; file: boolean }): never {
  const flags = [
    missing.file ? "the file (or an export run ID)" : undefined,
    missing.source ? "--source <platform>" : undefined,
  ].filter(Boolean);

  throwUsageError(
    `\`clerk migrate import\` is interactive and cannot prompt in agent mode. Pass ${flags.join(" and ")}.`,
    undefined,
    undefined,
    [
      {
        command: `clerk migrate import users.json --source ${sources[0]?.key ?? "clerk"} -y`,
        description: "Run non-interactively",
      },
    ],
  );
}
