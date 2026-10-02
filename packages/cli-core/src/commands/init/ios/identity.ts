import { dirname, resolve } from "node:path";
import { DOMParser } from "@xmldom/xmldom";
import * as plapi from "../../../lib/plapi.ts";
import { snapshotFile } from "./files.ts";
import { resolveInstance, type NativeAPI, type RemoteInput } from "./remote.ts";
import type { Inspection } from "./xcode.ts";

export type RemoteSelection = Pick<RemoteInput, "applicationId" | "instanceId"> &
  Partial<Pick<RemoteInput, "bundleIdentifier" | "appIdPrefix">>;
export type IdentityPrompt = (
  field: "bundleIdentifier" | "appIdPrefix",
  message: string,
) => Promise<string>;
const validBundle = (value: string | undefined): value is string =>
  !!value && value.length <= 255 && /^[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$/.test(value);

export async function discoverBundleIdentifier(
  inspection: Inspection,
): Promise<string | undefined> {
  const values: string[] = [];
  for (const { settings, selection } of inspection.contexts) {
    if (settings.INFOPLIST_PREPROCESS === "YES") return undefined;
    let value = settings.INFOPLIST_KEY_CFBundleIdentifier;
    if (settings.INFOPLIST_FILE) {
      try {
        const source = (
          await snapshotFile(
            selection.root,
            resolve(
              settings.SRCROOT ?? resolve(selection.root, dirname(selection.project)),
              settings.INFOPLIST_FILE,
            ),
          )
        ).source;
        if (/<!ENTITY/i.test(source)) return undefined;
        const xml = new DOMParser({
          errorHandler: () => {
            throw new Error("Invalid plist");
          },
        }).parseFromString(source, "text/xml");
        const root = xml.documentElement;
        const dictionary = Array.from(root.childNodes).filter((node) => node.nodeType === 1);
        if (
          root.tagName !== "plist" ||
          dictionary.length !== 1 ||
          dictionary[0]!.nodeName !== "dict"
        )
          return undefined;
        const children = Array.from(dictionary[0]!.childNodes).filter(
          (node) => node.nodeType === 1,
        );
        const identifiers = children.filter(
          (node) => node.nodeName === "key" && node.textContent === "CFBundleIdentifier",
        );
        if (identifiers.length !== 1) return undefined;
        const entry = children[children.indexOf(identifiers[0]!) + 1];
        if (entry?.nodeName !== "string") return undefined;
        const literal = entry.textContent ?? "";
        // Conflicting template and build-setting overrides need a caller decision.
        if (value && value !== literal) return undefined;
        value = literal;
      } catch {
        return undefined;
      }
    } else if (settings.GENERATE_INFOPLIST_FILE !== "YES") return undefined;
    value = (value ?? settings.PRODUCT_BUNDLE_IDENTIFIER)
      ?.replaceAll("$(PRODUCT_BUNDLE_IDENTIFIER)", settings.PRODUCT_BUNDLE_IDENTIFIER ?? "")
      .replaceAll("${PRODUCT_BUNDLE_IDENTIFIER}", settings.PRODUCT_BUNDLE_IDENTIFIER ?? "");
    if (!validBundle(value)) return undefined;
    values.push(value);
  }
  return new Set(values).size === 1 ? values[0] : undefined;
}

export async function discoverRemote(
  input: RemoteSelection,
  inspection: Inspection,
  api: NativeAPI,
  prompt?: IdentityPrompt,
) {
  const instance = await resolveInstance(input, api);
  const [native, applications] = await Promise.all([
    api.getNativeSettings(instance.applicationId, instance.instanceId),
    api.listIOSApplications(instance.applicationId, instance.instanceId),
  ]);
  const registrations = plapi.validateIOSApplications(applications);
  const nativeEnabled = plapi.validateNativeSettings(native).api_enabled;
  let bundleIdentifier = input.bundleIdentifier ?? (await discoverBundleIdentifier(inspection));
  let bundleSource = input.bundleIdentifier ? "explicit" : bundleIdentifier ? "xcode" : "missing";
  if (!bundleIdentifier && prompt) {
    bundleIdentifier = await prompt(
      "bundleIdentifier",
      "The Bundle ID is missing, customized, or differs across configurations. Enter the final Bundle ID to register:",
    );
    bundleSource = "confirmed";
  }
  if (bundleIdentifier !== undefined && !validBundle(bundleIdentifier))
    throw new Error("Supply a valid final Bundle ID.");
  const matches = registrations.filter(
    (app) => app.bundle_id.toLowerCase() === bundleIdentifier?.toLowerCase(),
  );
  let appIdPrefix =
    input.appIdPrefix ?? (matches.length === 1 ? matches[0]!.app_id_prefix : undefined);
  let prefixSource = input.appIdPrefix
    ? "explicit"
    : appIdPrefix
      ? "clerk-registration"
      : "missing";
  const conflict =
    matches.length > 1 || matches.some((app) => appIdPrefix && app.app_id_prefix !== appIdPrefix);
  if (!appIdPrefix && bundleIdentifier && !conflict && prompt) {
    appIdPrefix = await prompt(
      "appIdPrefix",
      `No existing Clerk registration supplies the App ID Prefix for ${bundleIdentifier}. Enter its 10-character Apple App ID Prefix (which may differ from the Team ID):`,
    );
    prefixSource = "confirmed";
  }
  if (appIdPrefix !== undefined && !/^[A-Z0-9]{10}$/.test(appIdPrefix))
    throw new Error("Supply a valid ten-character Apple App ID Prefix.");
  const issues = [
    ...(!bundleIdentifier
      ? [
          "Confirm the final Bundle ID; Xcode's inspected configurations do not establish one ordinary value.",
        ]
      : []),
    ...(!appIdPrefix
      ? ["Supply the Apple App ID Prefix; no unique matching Clerk registration supplies it."]
      : []),
    ...(conflict
      ? ["Existing native registrations conflict; review them in the Clerk Dashboard."]
      : []),
  ];
  return {
    instance,
    nativeEnabled,
    registrations,
    bundleIdentifier,
    appIdPrefix,
    bundleSource,
    prefixSource,
    issues,
    context:
      bundleIdentifier && appIdPrefix && !conflict
        ? { ...instance, bundleIdentifier, appIdPrefix }
        : undefined,
  };
}
export type IdentityDiscovery = Awaited<ReturnType<typeof discoverRemote>>;
export function describeIdentity(discovery: IdentityDiscovery) {
  return {
    nativeApiEnabled: discovery.nativeEnabled,
    registrations: discovery.registrations.map((app) => ({
      bundleIdentifier: app.bundle_id,
      appIdPrefix: app.app_id_prefix,
    })),
    bundleIdentifier: discovery.bundleIdentifier,
    appIdPrefix: discovery.appIdPrefix,
    bundleSource: discovery.bundleSource,
    prefixSource: discovery.prefixSource,
    issues: discovery.issues,
  };
}
export class IdentityRequired extends Error {
  constructor(public discovery: IdentityDiscovery) {
    super(discovery.issues.join(" "));
  }
}
