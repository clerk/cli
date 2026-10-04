import { dirname, resolve } from "node:path";
import { auditIOSNativeAppleHealth } from "./native-apple.ts";
import { capabilityXML, planAllCapabilities } from "./capabilities.ts";
import { snapshotFile } from "./files.ts";
import { sdkLinked } from "./sdk.ts";
import { discoverRemote, describeIdentity } from "./identity.ts";
import { auditRemote, nativeAPI } from "./remote.ts";
import { resolvedSDKHealth, type Check } from "./sdk-health.ts";
import { describePreview, prepareSetup, type SetupOptions, type Dependencies } from "./workflow.ts";

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
  const checks: Check[] = [
    {
      name: "Xcode configuration coverage",
      status: preview.inspection.uncheckedConfigurations.length ? "warn" : "pass",
      message: `Inspected ${preview.inspection.contexts.map((context) => context.selection.configuration).join(", ")}; unchecked configurations: ${preview.inspection.uncheckedConfigurations.join(", ") || "none"}. Other platforms and app builds remain unverified.`,
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
  const capabilities = await planAllCapabilities(
    preview.inspection,
    preview.inspection.document.source,
    discovery?.instance.frontendHost,
  );
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
          platform: preview.inspection.input.selection.sdk === "macosx" ? "macos" : "ios",
        },
        dependencies.appleAPI,
      );
      const required = options.signInWithApple || health.runtime.current?.enabled;
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
        for (const context of preview.inspection.contexts) {
          let status: Check["status"] = "fail";
          let message = `Apple sign-in is requested or enabled in Clerk, but ${context.selection.configuration} has no Apple entitlement.`;
          const path = context.settings.CODE_SIGN_ENTITLEMENTS;
          if (path) {
            try {
              const snapshot = await snapshotFile(
                context.selection.root,
                resolve(
                  context.settings.SRCROOT ??
                    resolve(context.selection.root, dirname(context.selection.project)),
                  path,
                ),
              );
              if (capabilityXML(snapshot.source, undefined, true) === snapshot.source) {
                status = "pass";
                message = `${context.selection.configuration} has the Apple entitlement. Provisioning and sign-in remain unverified.`;
              }
            } catch {
              status = "warn";
              message = `The ${context.selection.configuration} Apple entitlement file could not be verified; inspect it in Xcode.`;
            }
          }
          checks.push({
            name: `Apple entitlement: ${context.selection.configuration}`,
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
  return {
    ...describePreview(preview),
    identity: discovery ? describeIdentity(discovery) : undefined,
    status: checks.some((check) => check.status === "fail") ? "failed" : "needs-verification",
    appIntegrationComplete: false,
    checks,
  };
}
