import type { FileAction } from "../frameworks/types.ts";
import { modulePath } from "./discovery.ts";
import { snapshotFile, type FileSnapshot } from "./files.ts";
import type { Inspection } from "./project.ts";
import { signInMainActivity, starterMainActivity, themeName } from "./starter-project.ts";

// Exact starter recipe, not Kotlin analysis: a header comment plus these token sequences.
// Quoted string contents are preserved during whitespace normalization.
const headerPattern = /^(?:\s*\/\/[^\n]*(?:\n|$))*/;
const body = (source: string) => source.replace(headerPattern, "").trim();
const tokens = (source: string) =>
  body(source)
    .match(/"(?:\\.|[^"\\])*"|[^\s]/g)
    ?.join("");

/** Where the starter's `MainActivity` is, and the app name its theme is declared under. */
async function starterActivity(
  inspection: Inspection,
): Promise<{ snapshot: FileSnapshot; name: string } | undefined> {
  const { selection, manifest } = inspection;
  // The theme the manifest applies names the app, as the template writes it.
  const theme = /android:theme\s*=\s*["']@style\/Theme\.([A-Za-z][A-Za-z0-9_]*)["']/.exec(
    manifest.source,
  );
  if (!theme) return undefined;
  const path = modulePath(
    selection.module,
    `src/main/java/${selection.namespace.replaceAll(".", "/")}/MainActivity.kt`,
  );
  try {
    return { snapshot: await snapshotFile(selection.root, path), name: theme[1]! };
  } catch {
    return undefined;
  }
}

/** Whether the module is the unchanged starter `clerk init --starter` wrote. */
export async function isUnchangedStarter(inspection: Inspection): Promise<boolean> {
  const activity = await starterActivity(inspection);
  return (
    activity !== undefined &&
    tokens(activity.snapshot.source) ===
      tokens(starterMainActivity(inspection.selection.namespace, activity.name))
  );
}

export interface StarterPlan {
  actions: FileAction[];
  snapshots: FileSnapshot[];
  /** Handoff task ids the plan completes. */
  tasks: string[];
  /** Why the sign-in screen wasn't planned. */
  reason?: string;
}

/**
 * Replaces the unchanged starter's `MainActivity` with the prebuilt sign-in screen when asked.
 * Anything else, including a `MainActivity` already carrying the screen, is left alone.
 */
export async function planStarter(inspection: Inspection, signInUI: boolean): Promise<StarterPlan> {
  const manual: StarterPlan = {
    actions: [],
    snapshots: [],
    tasks: [],
    reason:
      "Only the unchanged Compose starter gets the prebuilt sign-in screen; use the handoff for this app.",
  };
  if (!signInUI || inspection.sdk !== "ui") return { actions: [], snapshots: [], tasks: [] };
  const activity = await starterActivity(inspection);
  if (!activity) return manual;
  const { namespace } = inspection.selection;
  const content = signInMainActivity(namespace, activity.name);
  const current = tokens(activity.snapshot.source);
  if (current === tokens(content))
    return {
      actions: [
        {
          type: "skip",
          path: activity.snapshot.path,
          skipReason: "MainActivity already shows Clerk's prebuilt sign-in screen.",
        },
      ],
      snapshots: [activity.snapshot],
      tasks: ["optional-sign-in-ui"],
    };
  if (current !== tokens(starterMainActivity(namespace, activity.name))) return manual;
  const header = activity.snapshot.source.match(headerPattern)?.[0] ?? "";
  return {
    actions: [
      {
        type: "modify",
        path: activity.snapshot.path,
        content: header + content,
        description: `Show Clerk's prebuilt sign-in screen (${themeName(activity.name)} kept)`,
      },
    ],
    snapshots: [activity.snapshot],
    tasks: ["optional-sign-in-ui"],
  };
}
