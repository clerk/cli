import { CliError, ERROR_CODE, errorMessage } from "../../../lib/errors.ts";
import { maskCode } from "./gradle.ts";
import { describeIdentity, discoverIdentity, readDebugKeystore } from "./identity.ts";
import { auditRemote, nativeAPI, resolveInstance } from "./remote.ts";
import { CLERK_ANDROID_MIN_SDK, sdkInstalled, type Check } from "./sdk.ts";
import { KEY_RESOURCE } from "./project.ts";
import { describePreview, prepareSetup, type Dependencies, type SetupOptions } from "./workflow.ts";

/** The key the app passes to `Clerk.initialize`, when it's the resource or a string literal. */
function configuredKey(
  source: string | undefined,
  resourceKey: string | undefined,
): { key?: string; reason?: string } {
  if (!source) return { reason: "the Application source was not found" };
  const masked = maskCode(source, false);
  const call =
    /\bClerk\.initialize\s*\(([^;]*?)\)\s*$/m.exec(masked) ??
    /\bClerk\.initialize\s*\(([\s\S]*?)\)/.exec(masked);
  if (!call) return { reason: "Clerk.initialize is not called" };
  const args = call[1]!;
  if (new RegExp(`R\\.string\\.${KEY_RESOURCE}\\b`).test(args))
    return resourceKey
      ? { key: resourceKey }
      : { reason: `the ${KEY_RESOURCE} resource is missing from src/main/res/values/clerk.xml` };
  const literal = /["'](pk_(?:test|live)_[A-Za-z0-9+/=_-]+)["']/.exec(args);
  if (literal) return { key: literal[1] };
  return {
    reason:
      "the publishable key is computed rather than a literal or the clerk_publishable_key resource",
  };
}

export async function doctor(options: SetupOptions, dependencies: Dependencies = {}) {
  // Diagnosis is GET-only, and never blocks on what setup would refuse to edit.
  const preview = await prepareSetup(
    { ...options, remote: undefined, inspectOnly: true, readDebugKeystore: false },
    dependencies,
  );
  const api = dependencies.api ?? nativeAPI;
  const { inspection } = preview;
  const identity = await discoverIdentity(
    inspection.selection,
    options.fingerprints,
    options.readDebugKeystore === false ? false : (dependencies.debugKeystore ?? readDebugKeystore),
    options.signal,
  );
  preview.identity = identity;
  const instance = options.remote ? await resolveInstance(options.remote, api) : undefined;
  let remoteError: unknown;
  if (instance)
    try {
      preview.remote = await auditRemote(
        { ...instance, packageName: identity.applicationId, fingerprints: identity.fingerprints },
        api,
      );
    } catch (error) {
      options.signal?.throwIfAborted();
      remoteError = error;
    }
  const sdk = preview.sdk;
  const installed = sdkInstalled(inspection.dependencies, inspection.sdk);
  const checks: Check[] = [
    {
      name: "Android module coverage",
      status: "pass",
      message: `Inspected ${inspection.build.path} and ${inspection.manifest.path} for ${inspection.selection.applicationId}${inspection.selection.applicationIdSource === "gradle-debug" ? " (debug variant)" : ""}. Other modules, variants, and signing remain unverified.`,
    },
    {
      name: "SDK dependency",
      status: installed ? "pass" : "warn",
      message: installed
        ? `${inspection.dependencies.map((item) => `${item.product === "ui" ? "clerk-android-ui" : "clerk-android-api"}${item.version ? ` ${item.version}` : ""}`).join(", ")} is declared in ${inspection.build.path}.`
        : sdk.type === "skip"
          ? sdk.skipReason
          : "The Clerk SDK dependency needs installation.",
      remedy: installed ? undefined : "Run clerk init to add the dependency.",
    },
    preview.sdkCheck,
    preview.kotlinCheck,
    {
      name: "minSdk",
      status:
        inspection.minSdk.value !== undefined && inspection.minSdk.value >= CLERK_ANDROID_MIN_SDK
          ? "pass"
          : "fail",
      message:
        inspection.minSdk.value === undefined
          ? `minSdk could not be read from ${inspection.build.path}; the Clerk SDK needs ${CLERK_ANDROID_MIN_SDK} or newer.`
          : inspection.minSdk.value >= CLERK_ANDROID_MIN_SDK
            ? `minSdk ${inspection.minSdk.value} meets the Clerk SDK's ${CLERK_ANDROID_MIN_SDK} floor.`
            : `minSdk ${inspection.minSdk.value} is below the Clerk SDK's ${CLERK_ANDROID_MIN_SDK} floor.`,
      remedy:
        inspection.minSdk.value !== undefined && inspection.minSdk.value >= CLERK_ANDROID_MIN_SDK
          ? undefined
          : `Set minSdk = ${CLERK_ANDROID_MIN_SDK} in defaultConfig, or run clerk init.`,
    },
    {
      name: "Manifest",
      status: inspection.application.registered && inspection.internetPermission ? "pass" : "fail",
      message: [
        inspection.application.registered
          ? `The manifest registers ${inspection.application.className}.`
          : "The manifest registers no Application subclass.",
        inspection.internetPermission
          ? "The INTERNET permission is declared."
          : "The INTERNET permission is missing.",
      ].join(" "),
      remedy:
        inspection.application.registered && inspection.internetPermission
          ? undefined
          : "Run clerk init, or add android:name to <application> and the INTERNET uses-permission.",
    },
    {
      name: "Clerk initialization",
      status: inspection.application.initialized !== "none" ? "pass" : "fail",
      message:
        inspection.application.initialized !== "none"
          ? `${inspection.application.className} calls Clerk.initialize.`
          : `${inspection.application.className} does not call Clerk.initialize${inspection.application.reason ? `: ${inspection.application.reason}` : "."}`,
      remedy:
        inspection.application.initialized !== "none"
          ? undefined
          : "Run clerk init, or call Clerk.initialize(this, publishableKey = …) after super.onCreate().",
    },
  ];
  if (instance) {
    const configured = configuredKey(
      inspection.application.source?.source,
      inspection.keyResource.key,
    );
    const matches = configured.key === instance.publishableKey;
    checks.push({
      name: "Development publishable key",
      status: matches ? "pass" : configured.key ? "fail" : "warn",
      message: matches
        ? "The app initializes Clerk with the linked development instance's publishable key."
        : configured.key
          ? "The app initializes Clerk with a key that is not the linked development instance's publishable key."
          : `The publishable key could not be verified: ${configured.reason}.`,
      remedy: matches
        ? undefined
        : "Run clerk init to write the development key to src/main/res/values/clerk.xml, or pass it to Clerk.initialize.",
    });
  }
  if (preview.remote) {
    const { actions, registration } = preview.remote;
    checks.push(
      {
        name: "Native API",
        status: actions.includes("enable-native-api") ? "fail" : "pass",
        message: actions.includes("enable-native-api")
          ? "Native API is disabled for the development instance."
          : "Native API is enabled for the development instance.",
        remedy: actions.includes("enable-native-api")
          ? "Run clerk init, or enable Native API on the Native Applications page."
          : undefined,
      },
      {
        name: "Native registration",
        status: registration ? "pass" : "fail",
        message: registration
          ? `${identity.applicationId} is registered with ${registration.fingerprints.length} fingerprint${registration.fingerprints.length === 1 ? "" : "s"}.`
          : `${identity.applicationId} is not registered on the development instance.`,
        remedy: registration
          ? undefined
          : "Run clerk init to register the app, or add it on the Native Applications page.",
      },
    );
    if (registration)
      checks.push({
        name: "Debug signing fingerprint",
        status: identity.debug.status === "found" ? "pass" : "warn",
        message:
          identity.debug.status === "found"
            ? `This machine's debug certificate (${identity.debug.fingerprint}) is registered, so assetlinks.json covers debug builds.`
            : (identity.issues[0] ?? "The debug certificate fingerprint could not be read."),
        remedy:
          identity.debug.status === "found"
            ? undefined
            : "Build once to create the debug keystore, or pass --android-fingerprint to check a specific certificate.",
      });
  } else if (remoteError) {
    const message = errorMessage(remoteError);
    // A registration without this machine's fingerprint is a finding, not a failure to check.
    const blocked =
      remoteError instanceof CliError && remoteError.code === ERROR_CODE.ANDROID_SETUP_BLOCKED;
    checks.push({
      name: "Native registration",
      status: blocked ? "fail" : "warn",
      message: blocked ? message : `Clerk native settings could not be checked: ${message}`,
      remedy: blocked
        ? "Add the fingerprint on the Native Applications page; the CLI can't update a registration yet."
        : "Check your Clerk login and application access, then rerun clerk doctor.",
    });
  } else
    checks.push({
      name: "Native registration",
      status: "warn",
      message: "No linked Clerk application; registration and Native API were not checked.",
      remedy: "Run clerk link, then clerk doctor again.",
    });
  return {
    ...describePreview(preview),
    identity: describeIdentity(identity),
    status: checks.some((check) => check.status === "fail") ? "failed" : "needs-verification",
    appIntegrationComplete: false,
    checks,
  };
}
