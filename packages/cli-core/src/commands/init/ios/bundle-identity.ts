import { resolve } from "node:path";
import { readBoundedRegularFile } from "./bounded-file.ts";
import { pathIsSafelyWithinIOSRoot, relativeIOSPath } from "./discovery.ts";
import { isRecord } from "./pbx.ts";
import { parseIOSPlist } from "./plist.ts";
import type { IOSSourceEvidence, IOSValueResolution } from "./types.ts";

/** Resolve the packaged identity without executing plist preprocessors or build scripts. */
export async function resolveIOSBundleIdentity(options: {
  root: string;
  projectDirectory: string;
  setting: (name: string) => IOSValueResolution;
  expand: (value: string, evidence: IOSSourceEvidence) => IOSValueResolution;
}): Promise<IOSValueResolution> {
  const { root, projectDirectory, setting, expand } = options;
  const product = setting("PRODUCT_BUNDLE_IDENTIFIER");
  const unresolved = (reason: string, evidence = product.evidence): IOSValueResolution => ({
    state: "unresolved",
    raw: "",
    missingVariables: [reason],
    evidence,
  });
  const boolean = (name: string, fallback: boolean): boolean | undefined => {
    const value = setting(name);
    if (value.state === "missing") return fallback;
    if (value.state !== "resolved") return undefined;
    if (value.value === "YES") return true;
    if (value.value === "NO") return false;
    return undefined;
  };
  for (const name of [
    "GENERATE_INFOPLIST_FILE",
    "INFOPLIST_PREPROCESS",
    "INFOPLIST_EXPAND_BUILD_SETTINGS",
  ]) {
    const value = setting(name);
    if (value.state === "unresolved") return value;
  }
  const generated = boolean("GENERATE_INFOPLIST_FILE", false);
  const preprocess = boolean("INFOPLIST_PREPROCESS", false);
  const expandsSettings = boolean("INFOPLIST_EXPAND_BUILD_SETTINGS", true);
  if (generated === undefined || expandsSettings === undefined || preprocess !== false) {
    return unresolved("unproven Info.plist generation or preprocessing settings");
  }

  const file = setting("INFOPLIST_FILE");
  if (file.state === "unresolved") return file;
  if (file.state === "missing" || file.value === "") {
    return generated ? product : unresolved("no explicit or generated Info.plist identity");
  }
  const path = resolve(projectDirectory, file.value);
  const evidence: IOSSourceEvidence = {
    path: relativeIOSPath(root, path),
    keyPath: "CFBundleIdentifier",
  };
  if (!(await pathIsSafelyWithinIOSRoot(root, path))) {
    return unresolved("Info.plist is outside the inspected root", file.evidence);
  }
  const contents = await readBoundedRegularFile(path, 2_000_000);
  if (contents.status !== "ok") {
    return unresolved(`Info.plist is ${contents.status}`, [evidence]);
  }
  try {
    const plist = parseIOSPlist(new TextDecoder().decode(contents.bytes));
    if (!isRecord(plist)) return unresolved("invalid Info.plist dictionary", [evidence]);
    // Xcode's generated PRODUCT_BUNDLE_IDENTIFIER wins over the source plist's
    // CFBundleIdentifier, including INFOPLIST_KEY_CFBundleIdentifier overrides.
    if (generated) return product;
    const identifier = plist.CFBundleIdentifier;
    if (identifier === undefined) {
      return unresolved("Info.plist has no CFBundleIdentifier", [evidence]);
    }
    if (typeof identifier !== "string" || identifier.length === 0) {
      return unresolved("invalid Info.plist CFBundleIdentifier", [evidence]);
    }
    return expandsSettings
      ? expand(identifier, evidence)
      : { state: "resolved", value: identifier, evidence: [evidence] };
  } catch {
    return unresolved("unreadable XML Info.plist", [evidence]);
  }
}
