import { auditIOSNativeAppleHealth } from "./native-apple.ts";
import {
  hasCapabilities,
  personalTeamConflictNote,
  personalTeamConflicts,
  planAllCapabilities,
  sharedMacDomainsNote,
  readEntitlements,
} from "./capabilities.ts";
import { auditProduction } from "./production.ts";
import { errorMessage } from "../../../lib/errors.ts";
import { sdkLinked } from "./sdk.ts";
import { discoverRemote, describeIdentity, platformBundleConflict } from "./identity.ts";
import { auditRemote, nativeAPI } from "./remote.ts";
import { resolvedSDKHealth, type Check } from "./sdk-health.ts";
import { signedByPersonalTeam } from "./teams.ts";
import { describePreview, prepareSetup, type SetupOptions, type Dependencies } from "./workflow.ts";
import { contextLabel, nativePlatform, platformsLabel } from "./xcode.ts";

export async function doctor(options: SetupOptions, dependencies: Dependencies = {}) {
  // Diagnosis is GET-only and does not require opting into provider activation.
  const preview = await prepareSetup(
    {
      ...options,
      remote: undefined,
      resolvePackages: false,
      capabilities: false,
      signInWithApple: false,
      checkAppleConnection: false,
    },
    dependencies,
  );
  const discovery = options.remote
    ? await discoverRemote(options.remote, preview.inspection, dependencies.api ?? nativeAPI)
    : undefined;
  preview.discovery = discovery;
  if (discovery?.context)
    preview.remote = await auditRemote(discovery.context, dependencies.api ?? nativeAPI);
  const sdk = preview.sdk;
  const { inspection } = preview;
  const multiplatform = nativePlatform(inspection) === "multiplatform";
  const label = (context: (typeof inspection.contexts)[number]) =>
    contextLabel(inspection, context);
  const checks: Check[] = [
    {
      name: "Xcode configuration coverage",
      status:
        inspection.uncheckedConfigurations.length || inspection.unsupportedPlatforms.length
          ? "warn"
          : "pass",
      message: `Inspected ${[...new Set(inspection.contexts.map((context) => context.selection.configuration))].join(", ")}${multiplatform ? ` for ${platformsLabel(inspection)}` : ""}; unchecked configurations: ${inspection.uncheckedConfigurations.join(", ") || "none"}.${inspection.unsupportedPlatforms.length ? ` Clerk doesn't set up this target's other platforms: ${inspection.unsupportedPlatforms.join(", ")}.` : ""} Other platforms and app builds remain unverified.`,
    },
    {
      name: "SDK project linkage",
      status: sdk.type === "skip" && sdkLinked(sdk) ? "pass" : "warn",
      message: sdk.type === "skip" ? sdk.skipReason : "Requested SDK products need installation.",
    },
    preview.sdkCheck.status === "fail"
      ? preview.sdkCheck
      : ((await resolvedSDKHealth(preview.inspection.input)) ?? preview.sdkCheck),
    {
      name: "Native registration",
      status: preview.remote && !preview.remote.actions.length ? "pass" : "warn",
      message: preview.remote
        ? preview.remote.actions.join(", ") ||
          "Confirmed identity is registered and Native API is enabled."
        : "No confirmed native identity was supplied.",
    },
  ];
  // With a Clerk application, the native identity check reports this instead.
  const bundleConflict = discovery ? undefined : await platformBundleConflict(inspection);
  if (bundleConflict)
    checks.push({ name: "Bundle ID across platforms", status: "warn", message: bundleConflict });
  if (discovery)
    checks.push(
      {
        name: "Native API",
        status: discovery.nativeEnabled ? "pass" : "warn",
        message: discovery.nativeEnabled ? "Native API is enabled." : "Native API is disabled.",
      },
      {
        name: "Native identity",
        status: discovery.issues.length ? "warn" : "pass",
        message:
          discovery.issues.join(" ") ||
          `Bundle ID from ${discovery.bundleSource}; App ID Prefix from ${discovery.prefixSource}.`,
      },
    );
  // The same rule as setup: a Personal Team gets no Sign in with Apple, and no Associated Domain on macOS.
  const personalTeam = signedByPersonalTeam(inspection, dependencies.xcodeTeams);
  const mac = inspection.contexts.some((context) => context.selection.sdk === "macosx");
  if (personalTeam)
    checks.push({
      name: "Personal Team",
      status: "warn",
      // Doctor changes nothing, so it says what's unavailable rather than what setup left out.
      message: multiplatform
        ? "This app is signed by a Personal Team, which can't use Sign in with Apple, or Associated Domains for passkeys and password AutoFill on a Mac, so those stay off in the macOS app. The iOS app keeps its Associated Domains for the iOS Simulator."
        : mac
          ? "This app is signed by a Personal Team, which can't use Sign in with Apple, or Associated Domains for passkeys and password AutoFill on a Mac."
          : "This app is signed by a Personal Team, which can't use Sign in with Apple.",
    });
  const capabilities = await planAllCapabilities(
    inspection,
    inspection.document.source,
    discovery?.instance.frontendHost,
    false,
    (selection) => !(personalTeam && selection.sdk === "macosx"),
  );
  // Setup never removes entitlements, so one the team can't sign can still be there. A file a
  // Multiplatform target's iOS and macOS builds share is the exception: setup gives macOS a copy.
  if (personalTeam)
    for (const context of inspection.contexts) {
      const file = context.settings.CODE_SIGN_ENTITLEMENTS?.trim();
      const mac = context.selection.sdk === "macosx";
      let conflicts: string[];
      try {
        const source = await readEntitlements(context);
        conflicts = source === undefined ? [] : personalTeamConflicts(source, mac);
      } catch {
        continue;
      }
      const sharedWithIOS =
        mac &&
        inspection.contexts.some(
          (other) =>
            other.selection.configuration === context.selection.configuration &&
            other.selection.sdk !== "macosx" &&
            other.settings.CODE_SIGN_ENTITLEMENTS?.trim() === file,
        );
      const notes = [];
      if (sharedWithIOS && conflicts.includes("Associated Domains")) {
        conflicts = conflicts.filter((conflict) => conflict !== "Associated Domains");
        notes.push(
          sharedMacDomainsNote(
            file!,
            capabilities.contexts.some(
              (planned) =>
                planned.macCopyOf && planned.configuration === context.selection.configuration,
            ),
          ),
        );
      }
      if (conflicts.length)
        notes.unshift(personalTeamConflictNote(file!, conflicts, multiplatform));
      if (notes.length)
        checks.push({
          name: `Personal Team entitlements: ${label(context)}`,
          status: "warn",
          message: notes.join(" "),
        });
    }
  for (const context of capabilities.contexts)
    checks.push({
      name: `Capabilities: ${context.scope}`,
      status: context.status === "satisfied" ? "pass" : "warn",
      message:
        context.reason ??
        (context.status === "planned"
          ? `Local capability changes are still needed for ${context.configuration}.`
          : `${context.configuration} capability settings are present; signing remains unverified.`),
    });
  if (discovery?.bundleIdentifier) {
    try {
      const health = await auditIOSNativeAppleHealth(
        {
          ...discovery.instance,
          bundleIdentifier: discovery.bundleIdentifier,
          platform: nativePlatform(inspection),
        },
        dependencies.appleAPI,
      );
      const required =
        !personalTeam && (options.signInWithApple || health.runtime.current?.enabled);
      checks.push({
        name: "Native Apple connection",
        status:
          health.runtime.status === "satisfied" ||
          (health.runtime.current?.enabled === false && !required)
            ? "pass"
            : "warn",
        message:
          health.runtime.status === "satisfied"
            ? "Native Apple sign-in is enabled for the confirmed Bundle ID."
            : health.runtime.current?.enabled === false && !required
              ? "Apple sign-in is disabled; no Apple entitlement is required by this connection."
              : health.runtime.blockers.map((blocker) => blocker.message).join("; ") ||
                "Native Apple sign-in still needs configuration in Clerk.",
      });
      if (required)
        for (const context of inspection.contexts) {
          let status: Check["status"] = "fail";
          let message = `Apple sign-in is requested or enabled in Clerk, but ${label(context)} has no Apple entitlement.`;
          try {
            const source = await readEntitlements(context);
            if (source !== undefined && hasCapabilities(source, undefined, true)) {
              status = "pass";
              message = `${label(context)} has the Apple entitlement. Provisioning and sign-in remain unverified.`;
            }
          } catch {
            status = "warn";
            message = `The ${label(context)} Apple entitlement file could not be verified; inspect it in Xcode.`;
          }
          checks.push({
            name: `Apple entitlement: ${label(context)}`,
            status,
            message,
          });
        }
    } catch {
      checks.push({
        name: "Native Apple connection",
        status: "warn",
        message:
          "Apple provider settings could not be read. Review them in Clerk; no settings were changed.",
      });
    }
  } else
    checks.push({
      name: "Native Apple connection",
      status: "warn",
      message:
        "Supply the Clerk application and confirmed native identity to check provider settings.",
    });
  if (options.remote)
    try {
      // A prefix Clerk or the user confirmed for development is the app's; a signing-team guess isn't.
      const confirmedPrefix =
        discovery &&
        ["explicit", "confirmed", "clerk-registration"].includes(discovery.prefixSource)
          ? discovery.appIdPrefix
          : undefined;
      checks.push(
        ...(await auditProduction(
          preview.inspection,
          {
            applicationId: options.remote.applicationId,
            appIdPrefix: confirmedPrefix,
            configurationSelected: options.configuration != null,
          },
          dependencies.api ?? nativeAPI,
          options.signal,
        )),
      );
    } catch (error) {
      options.signal?.throwIfAborted();
      checks.push({
        name: "Production instance",
        status: "warn",
        message: `Production readiness could not be checked: ${errorMessage(error)}`,
        remedy:
          "Rerun clerk doctor. If it keeps failing, check the production instance in the Clerk Dashboard.",
      });
    }
  return {
    ...describePreview(preview),
    identity: discovery ? describeIdentity(discovery) : undefined,
    status: checks.some((check) => check.status === "fail") ? "failed" : "needs-verification",
    appIntegrationComplete: false,
    checks,
  };
}
