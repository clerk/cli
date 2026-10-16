import { dirname, resolve } from "node:path";
import { DOMParser } from "@xmldom/xmldom";
import { snapshotFile } from "./files.ts";
import type { Inspection } from "./xcode.ts";

/**
 * Finds the publishable key a build configuration sets through the recommended Info.plist entry:
 * `ClerkPublishableKey`, a literal or a `$(BUILD_SETTING)` that Xcode resolves per configuration.
 * Swift code isn't read: an app without the entry is reported as unresolved, and doctor doesn't
 * confirm that `Clerk.configure` reads the entry it found.
 */

type Context = Inspection["contexts"][number];

export type ConfiguredKey =
  | { status: "resolved"; key: string; source: string }
  | { status: "unresolved"; reason: string };

/** The Info.plist entry the suggested setup passes to `Clerk.configure`. */
export const PUBLISHABLE_KEY_ENTRY = "ClerkPublishableKey";
const PUBLISHABLE_KEY = /^pk_(?:test|live)_[A-Za-z0-9+/]+={0,2}$/;

/** Top-level string entries of an XML property list; undefined when it isn't one ordinary dictionary. */
function plistStrings(source: string): Map<string, string> | undefined {
  if (/<!ENTITY/i.test(source)) return undefined;
  try {
    const xml = new DOMParser({
      errorHandler: () => {
        throw new Error("Invalid plist.");
      },
    }).parseFromString(source, "text/xml");
    const root = xml.documentElement;
    const dictionaries = Array.from(root.childNodes).filter((node) => node.nodeType === 1);
    if (
      root.tagName !== "plist" ||
      dictionaries.length !== 1 ||
      dictionaries[0]!.nodeName !== "dict"
    )
      return undefined;
    const children = Array.from(dictionaries[0]!.childNodes).filter((node) => node.nodeType === 1);
    const strings = new Map<string, string>();
    for (let i = 0; i + 1 < children.length; i += 2)
      if (children[i]!.nodeName === "key" && children[i + 1]!.nodeName === "string")
        strings.set(children[i]!.textContent ?? "", children[i + 1]!.textContent ?? "");
    return strings;
  } catch {
    return undefined;
  }
}

/** The value an Info.plist entry has in this configuration, through a `$(BUILD_SETTING)` when it names one. */
async function plistValue(
  context: Context,
  name: string,
): Promise<{ value?: string; setting?: string; reason?: string }> {
  const { settings, selection } = context;
  const path = settings.INFOPLIST_FILE;
  if (!path) return { reason: `the target has no Info.plist file for its ${name} entry` };
  if (settings.INFOPLIST_PREPROCESS === "YES") return { reason: "the Info.plist is preprocessed" };
  let strings: Map<string, string> | undefined;
  try {
    const sourceRoot = settings.SRCROOT ?? resolve(selection.root, dirname(selection.project));
    strings = plistStrings((await snapshotFile(selection.root, resolve(sourceRoot, path))).source);
  } catch {
    strings = undefined;
  }
  if (!strings) return { reason: "the Info.plist could not be read" };
  const raw = strings.get(name)?.trim();
  if (raw === undefined) return { reason: `the Info.plist has no ${name} string entry` };
  const reference = /^\$(?:\(([A-Za-z_]\w*)\)|\{([A-Za-z_]\w*)\})$/.exec(raw);
  const setting = reference ? (reference[1] ?? reference[2]) : undefined;
  return { value: setting ? settings[setting] : raw, setting };
}

export async function configuredPublishableKey(context: Context): Promise<ConfiguredKey> {
  const configuration = context.selection.configuration;
  const entry = await plistValue(context, PUBLISHABLE_KEY_ENTRY);
  if (entry.reason) return { status: "unresolved", reason: entry.reason };
  if (!entry.value || !PUBLISHABLE_KEY.test(entry.value))
    return {
      status: "unresolved",
      reason: entry.setting
        ? `the Info.plist entry ${PUBLISHABLE_KEY_ENTRY} reads the ${entry.setting} build setting, which isn't a publishable key in ${configuration}`
        : `the Info.plist entry ${PUBLISHABLE_KEY_ENTRY} isn't a publishable key`,
    };
  return {
    status: "resolved",
    key: entry.value,
    source: entry.setting
      ? `the Info.plist entry ${PUBLISHABLE_KEY_ENTRY}, set by the ${entry.setting} build setting`
      : `the Info.plist entry ${PUBLISHABLE_KEY_ENTRY}`,
  };
}
