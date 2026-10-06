/**
 * The prompts behind an interactive `clerk migrate import`.
 *
 * Each one fills in exactly one thing the command was not given: the file, or
 * the source.
 *
 * Nothing here runs for an agent, a non-TTY run or `--json`: `run` raises a
 * usage error naming what to pass instead.
 */

import { select } from "../../lib/listage.ts";
import { text } from "../../lib/prompts.ts";
import { fileExists, getFileType } from "./lib/transform.ts";
import { sources } from "./sources/registry.ts";

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
