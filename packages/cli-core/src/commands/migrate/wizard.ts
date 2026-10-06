/**
 * The prompts behind an interactive `clerk migrate import`.
 *
 * Each one fills in exactly one thing the command was not given: the file,
 * the source when the file does not name its own, and Firebase's hash
 * parameters when neither the flags nor the export carry them.
 *
 * Nothing here runs for an agent, a non-TTY run or `--json`: `run` raises a
 * usage error naming what to pass instead.
 */

import { select } from "../../lib/listage.ts";
import { log } from "../../lib/log.ts";
import { text } from "../../lib/prompts.ts";
import { fileExists, getFileType } from "./lib/transform.ts";
import { sources } from "./sources/registry.ts";
import type { FirebaseHashConfig } from "./types.ts";

/** Trims a description down to a single readable hint line. */
function hint(description: string): string {
  const firstSentence = description.split(". ")[0] ?? description;
  return firstSentence.length > 96 ? `${firstSentence.slice(0, 93)}...` : firstSentence;
}

/** Asks which platform the file came from. Built from the registry. */
export async function promptForSource(): Promise<string> {
  return select<string>({
    message: "Which platform did this file come from?",
    choices: sources.map((entry) => ({
      name: entry.label,
      value: entry.key,
      description: hint(entry.description),
    })),
  });
}

/** Asks for the file to import. */
export async function promptForFile(): Promise<string> {
  const answer = await text({
    message: "Path to the exported user file (JSON or CSV)",
    validate: (value) => {
      const file = value?.trim();
      if (!file) return "A file path is required";
      if (!fileExists(file)) return `File not found: ${file}`;
      if (!getFileType(file)) return "Provide a .json or .csv file";
      return undefined;
    },
  });
  return answer.trim();
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
 * Collects Firebase's four hash parameters.
 *
 * Asked as a set because a partial set produces a digest that verifies against
 * nothing. Pressing enter at the first leaves the config unset, which is
 * correct for an export with no password hashes.
 */
export async function promptForFirebaseHashConfig(): Promise<FirebaseHashConfig | undefined> {
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
