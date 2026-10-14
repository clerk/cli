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
import { password, text } from "../../lib/prompts.ts";
import { MAX_SCRYPT_COST } from "./lib/firebase-hash.ts";
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
      // Clerk refuses a cost above 16: caught here, not after all four answers.
      const parsed = Number(value?.trim());
      return Number.isInteger(parsed) && parsed >= 1 && parsed <= MAX_SCRYPT_COST
        ? undefined
        : `Enter a whole number from 1 to ${MAX_SCRYPT_COST}`;
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

  // Masked: with the exported hashes and salts, the signer key is what lets
  // anyone verify, or crack, the passwords offline.
  const signerKey = (
    await password({
      message: "base64 signer key (leave blank if this export has no passwords)",
    })
  ).trim();
  if (!signerKey) return undefined;

  // Blank is a valid separator: some projects have none.
  const saltSeparator = (
    await text({ message: "base64 salt separator (leave blank if the project has none)" })
  ).trim();

  return {
    base64_signer_key: signerKey,
    base64_salt_separator: saltSeparator,
    rounds: await askNumber("rounds"),
    mem_cost: await askNumber("mem cost"),
  };
}
