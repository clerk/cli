import { dirname, resolve } from "node:path";
import { DOMParser } from "@xmldom/xmldom";
import { bundleIdentifiersEqual } from "../../../lib/apple-native-identity.ts";
import { snapshotFile } from "./files.ts";
import { resolveInstance, type NativeAPI, type RemoteInput } from "./remote.ts";
import type { Inspection } from "./xcode.ts";
import { setupError } from "./types.ts";
import { CliError, ERROR_CODE, EXIT_CODE } from "../../../lib/errors.ts";

export type RemoteSelection = Pick<RemoteInput, "applicationId" | "instanceId"> &
  Partial<Pick<RemoteInput, "bundleIdentifier" | "appIdPrefix">> & {
    /** Use the signing team without asking (`--yes`); otherwise it's only offered as a suggestion. */
    acceptSuggestedPrefix?: boolean;
  };
export type IdentityPrompt = (
  field: "bundleIdentifier" | "appIdPrefix",
  message: string,
  suggestion?: string,
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
            throw setupError("INVALID_PLIST_KEEP");
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
        // A generated Info.plist fills CFBundleIdentifier from the build settings,
        // so a partial plist without it falls through to them.
        const generated = identifiers.length === 0 && settings.GENERATE_INFOPLIST_FILE === "YES";
        if (!generated) {
          if (identifiers.length !== 1) return undefined;
          const entry = children[children.indexOf(identifiers[0]!) + 1];
          if (entry?.nodeName !== "string") return undefined;
          const literal = entry.textContent ?? "";
          // Conflicting template and build-setting overrides need a caller decision.
          if (value && value !== literal) return undefined;
          value = literal;
        }
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
  const registrations = applications;
  const nativeEnabled = native.api_enabled;
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
    throw setupError("Supply a valid final Bundle ID.");
  const matches = bundleIdentifier
    ? registrations.filter((app) => bundleIdentifiersEqual(app.bundle_id, bundleIdentifier))
    : [];
  let appIdPrefix =
    input.appIdPrefix ?? (matches.length === 1 ? matches[0]!.app_id_prefix : undefined);
  let prefixSource = input.appIdPrefix
    ? "explicit"
    : appIdPrefix
      ? "clerk-registration"
      : "missing";
  const conflict =
    matches.length > 1 || matches.some((app) => appIdPrefix && app.app_id_prefix !== appIdPrefix);
  // Apple uses the Team ID as the App ID Prefix for every App ID created since 2011, so one
  // signing team across the inspected configurations is the best suggestion; a legacy prefix can still be entered.
  const teams = new Set(inspection.contexts.map(({ settings }) => settings.DEVELOPMENT_TEAM ?? ""));
  const [team] = teams;
  const suggestedPrefix = teams.size === 1 && /^[A-Z0-9]{10}$/.test(team!) ? team : undefined;
  if (!appIdPrefix && bundleIdentifier && !conflict) {
    if (suggestedPrefix && input.acceptSuggestedPrefix) {
      appIdPrefix = suggestedPrefix;
      prefixSource = "signing-team";
    } else if (prompt) {
      appIdPrefix = await prompt(
        "appIdPrefix",
        suggestedPrefix
          ? `Which App ID Prefix should Clerk register for ${bundleIdentifier}?`
          : `Enter the 10-character Apple App ID Prefix for ${bundleIdentifier}:`,
        suggestedPrefix,
      );
      prefixSource = "confirmed";
    }
  }
  const invalidPrefix = appIdPrefix !== undefined && !/^[A-Z0-9]{10}$/.test(appIdPrefix);
  if (invalidPrefix && prefixSource !== "clerk-registration")
    throw setupError("Supply a valid ten-character Apple App ID Prefix.");
  const issues = [
    ...(!bundleIdentifier
      ? [
          "Confirm the final Bundle ID; Xcode's inspected configurations do not establish one ordinary value.",
        ]
      : []),
    ...(!appIdPrefix
      ? [
          suggestedPrefix && !conflict
            ? `Confirm the Apple App ID Prefix with the user: the signing team suggests ${suggestedPrefix}, or they can enter a different one.`
            : "Supply the Apple App ID Prefix; no unique matching Clerk registration supplies it.",
        ]
      : []),
    ...(conflict
      ? ["Existing native registrations conflict; review them in the Clerk Dashboard."]
      : []),
    ...(invalidPrefix
      ? [
          "The matching Clerk registration has an invalid Apple App ID Prefix. Correct its ten-character prefix in the Clerk Dashboard, then retry.",
        ]
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
    suggestedPrefix,
    issues,
    context:
      bundleIdentifier && appIdPrefix && !conflict && !invalidPrefix
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
    ...(discovery.appIdPrefix || !discovery.suggestedPrefix
      ? {}
      : { suggestedAppIdPrefix: discovery.suggestedPrefix }),
    issues: discovery.issues,
  };
}
export class IdentityRequired extends CliError {
  constructor(public discovery: IdentityDiscovery) {
    super(discovery.issues.join(" "), { code: ERROR_CODE.USAGE_ERROR, exitCode: EXIT_CODE.USAGE });
  }
}
