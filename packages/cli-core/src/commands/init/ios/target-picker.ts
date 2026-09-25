import { select } from "../../../lib/listage.ts";
import { withSpinner } from "../../../lib/spinner.ts";
import { hasIncompleteIOSContainerDiscovery, inspectIOSProject } from "./inspect.ts";

/** Choose a target using the same selector and discovery rules as explicit --target. */
export async function pickAppleNativeTarget(options: {
  root: string;
  target?: string;
  interactive: boolean;
}): Promise<string | undefined> {
  if (
    options.target != null ||
    !options.interactive ||
    !process.stdin.isTTY ||
    !process.stdout.isTTY
  ) {
    return options.target;
  }

  const inspection = await withSpinner("Finding Xcode application targets...", async () =>
    inspectIOSProject(options.root, { exhaustiveContainerDiscovery: true }),
  );
  if (
    inspection.selection.state !== "ambiguous" ||
    hasIncompleteIOSContainerDiscovery(inspection)
  ) {
    return undefined;
  }

  const candidates = inspection.selection.candidates;
  const choices = candidates.map((candidate) => ({
    value: candidate.targetId,
    name: `${candidate.targetName} — iOS — ${candidate.projectPath}`,
    description: candidate.targetId,
    // A copied project can reuse an object ID. Preserve the inspector's refusal
    // rather than presenting a choice the existing selector cannot distinguish.
    disabled:
      candidates.filter(
        (other) => other.targetId === candidate.targetId || other.targetName === candidate.targetId,
      ).length > 1
        ? "Target ID is shared; run from this project's directory."
        : false,
  }));
  if (choices.every((choice) => choice.disabled)) return undefined;

  // Planning inspects again after the prompt; this inventory never authorizes edits.
  return select({ message: "Which application target would you like to set up?", choices });
}
