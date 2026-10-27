import type { FileAction, ScaffoldPlan } from "../frameworks/types.ts";
import { maskCode } from "./gradle.ts";
import { maskXml } from "./project.ts";
import { GENERATED, GENERATED_APPLICATION, KEY_RESOURCE, type Inspection } from "./project.ts";
import {
  ALREADY_INSTALLED,
  CLERK_ANDROID_MIN_SDK,
  planSdkDependencies,
  sdkInstalled,
} from "./sdk.ts";
import { ANDROID_QUICKSTART, setupError } from "./types.ts";

export interface AndroidPlan extends ScaffoldPlan {
  /** The build-script action, first in `actions`. */
  sdk: FileAction;
  /** Whether the Application class initializes Clerk once this plan applies. */
  initializes: boolean;
}

/** Whether the file action writes something. */
export function writes(action: FileAction): action is Exclude<FileAction, { type: "skip" }> {
  return action.type !== "skip";
}

export function keyResourceSource(publishableKey: string): string {
  return `<?xml version="1.0" encoding="utf-8"?>\n<resources>\n    <!-- ${GENERATED} -->\n    <string name="${KEY_RESOURCE}" translatable="false">${publishableKey}</string>\n</resources>\n`;
}

export function generatedApplication(namespace: string): string {
  return `package ${namespace}\n\nimport android.app.Application\nimport com.clerk.api.Clerk\n\n// ${GENERATED}\nclass ${GENERATED_APPLICATION} : Application() {\n    override fun onCreate() {\n        super.onCreate()\n        Clerk.initialize(this, publishableKey = getString(R.string.${KEY_RESOURCE}))\n    }\n}\n`;
}

/**
 * Plans the local edits for the inspected module. Pure: nothing is read or written here. With
 * `skipDependencies`, the dependency lines (and their catalog entries) are left out for that
 * reason; everything else, the minSdk raise included, is still planned.
 */
export function planAndroidSetup(
  inspection: Inspection,
  publishableKey?: string,
  options: { skipDependencies?: string } = {},
): AndroidPlan {
  const { selection, application } = inspection;
  if (publishableKey !== undefined && !/^pk_test_[A-Za-z0-9+/=_-]+$/.test(publishableKey))
    throw setupError("Android setup requires the development publishable key.");
  const actions: FileAction[] = [];
  const changes: string[] = [];
  const catalogChanges: string[] = [];
  const notes: string[] = [];
  // Build script: minSdk first (its offsets come from the inspected source), then dependencies.
  let build = inspection.build.source;
  let catalogSource = inspection.catalog?.source;
  if (inspection.minSdk.value === undefined)
    notes.push(
      `minSdk could not be read from ${inspection.build.path} (a convention plugin or a computed value may set it); the Clerk SDK needs ${CLERK_ANDROID_MIN_SDK} or newer, so check it where it's set.`,
    );
  else if (inspection.minSdk.value < CLERK_ANDROID_MIN_SDK) {
    if (inspection.minSdk.source === "literal" && inspection.minSdk.edit) {
      const { start, end } = inspection.minSdk.edit;
      build = `${build.slice(0, start)}${CLERK_ANDROID_MIN_SDK}${build.slice(end)}`;
      changes.push(`raise minSdk from ${inspection.minSdk.value} to ${CLERK_ANDROID_MIN_SDK}`);
    } else if (
      inspection.minSdk.source === "catalog" &&
      inspection.minSdk.catalogKey &&
      catalogSource
    ) {
      // The catalog value is shared, so raising it there moves every module that reads it.
      const key = inspection.minSdk.catalogKey;
      catalogSource = catalogSource.replace(
        new RegExp(
          `^([ \\t]*${key.replace(/[-.]/g, "\\$&")}[ \\t]*=[ \\t]*["'])${inspection.minSdk.value}(["'])`,
          "m",
        ),
        `$1${CLERK_ANDROID_MIN_SDK}$2`,
      );
      catalogChanges.push(
        `raise ${key} from ${inspection.minSdk.value} to ${CLERK_ANDROID_MIN_SDK} (every module reading it moves too)`,
      );
    }
  }
  const sdk = options.skipDependencies
    ? { build, catalog: catalogSource, added: [] as string[] }
    : planSdkDependencies({
        build,
        catalogSource,
        sdk: inspection.sdk,
        minimumVersion: inspection.minimumVersion,
        dependencies: inspection.dependencies,
      });
  build = sdk.build;
  for (const added of sdk.added) changes.push(`add ${added}`);
  if (sdk.added.length) catalogChanges.push("add the Clerk SDK");
  if (inspection.catalog && sdk.catalog !== undefined && sdk.catalog !== inspection.catalog.source)
    actions.push({
      type: "modify",
      path: inspection.catalog.path,
      content: sdk.catalog,
      description: catalogChanges
        .map((c, i) => (i ? c : c[0]!.toUpperCase() + c.slice(1)))
        .join("; "),
    });
  const sdkAction: FileAction =
    build === inspection.build.source
      ? {
          type: "skip",
          path: inspection.build.path,
          skipReason:
            options.skipDependencies ??
            (sdkInstalled(inspection.dependencies, inspection.sdk)
              ? ALREADY_INSTALLED
              : "No build script changes are needed."),
        }
      : {
          type: "modify",
          path: inspection.build.path,
          content: build,
          description: changes.map((c, i) => (i ? c : c[0]!.toUpperCase() + c.slice(1))).join("; "),
        };
  actions.push(sdkAction);
  // Application class.
  const initCall = `com.clerk.api.Clerk.initialize(this, publishableKey = getString(${selection.namespace}.R.string.${KEY_RESOURCE}))`;
  let initializes = application.initialized !== "none";
  let registerClass = false;
  if (application.initialized === "managed")
    actions.push({
      type: "skip",
      path: application.path,
      skipReason: `${application.className} already initializes Clerk from the ${KEY_RESOURCE} resource.`,
    });
  else if (application.initialized === "custom")
    actions.push({
      type: "skip",
      path: application.path,
      skipReason: `${application.className} already initializes Clerk with its own key; it was left unchanged.`,
    });
  else if (!application.editable)
    actions.push({ type: "skip", path: application.path, skipReason: application.reason! });
  else if (!application.source) {
    actions.push({
      type: "create",
      path: application.path,
      content: generatedApplication(selection.namespace),
      description: "Initialize Clerk when the app starts",
    });
    initializes = true;
    registerClass = !application.registered;
  } else {
    const source = application.source.source;
    const masked = maskCode(source);
    const match = /\bsuper\.onCreate\s*\(\s*\)/.exec(masked)!;
    const callEnd = match.index + match[0].length;
    // After the whole line when only a comment follows the call; right after the call when a
    // `;` or `}` shares its line.
    const lineEnd = (masked.indexOf("\n", callEnd) + 1 || source.length + 1) - 1;
    const end = /^[ \t]*$/.test(masked.slice(callEnd, lineEnd)) ? lineEnd : callEnd;
    const indent = /([ \t]*)[^\r\n]*$/.exec(source.slice(0, match.index))![1] || "        ";
    actions.push({
      type: "modify",
      path: application.path,
      content: `${source.slice(0, end)}\n${indent}${initCall}${source.slice(end)}`,
      description: "Initialize Clerk after super.onCreate()",
    });
    initializes = true;
    registerClass = !application.registered;
  }
  // Manifest: offsets come from the comment-masked source, so a commented-out element is skipped.
  let manifest = inspection.manifest.source;
  const manifestChanges: string[] = [];
  if (registerClass) {
    const at = maskXml(manifest).search(/<application\b/) + "<application".length;
    manifest = `${manifest.slice(0, at)} android:name=".${GENERATED_APPLICATION}"${manifest.slice(at)}`;
    manifestChanges.push(`register ${application.className}`);
  }
  if (!inspection.internetPermission) {
    const open = /<manifest\b[^>]*>/.exec(maskXml(manifest));
    if (!open) throw setupError("AndroidManifest.xml has no manifest element.");
    const at = open.index + open[0].length;
    manifest = `${manifest.slice(0, at)}\n    <uses-permission android:name="android.permission.INTERNET" />${manifest.slice(at)}`;
    manifestChanges.push("add the INTERNET permission");
  }
  actions.push(
    manifestChanges.length
      ? {
          type: "modify",
          path: inspection.manifest.path,
          content: manifest,
          description: manifestChanges
            .map((c, i) => (i ? c : c[0]!.toUpperCase() + c.slice(1)))
            .join("; "),
        }
      : {
          type: "skip",
          path: inspection.manifest.path,
          skipReason:
            "The manifest already registers the Application class and the INTERNET permission.",
        },
  );
  // Key resource.
  const { keyResource } = inspection;
  if (application.initialized === "custom")
    actions.push({
      type: "skip",
      path: keyResource.path,
      skipReason: `Not written: ${application.className} initializes Clerk with its own key.`,
    });
  else if (publishableKey === undefined)
    actions.push({
      type: "skip",
      path: keyResource.path,
      skipReason:
        "Written with the development publishable key once a Clerk application is chosen.",
    });
  else if (keyResource.snapshot && keyResource.key === publishableKey)
    actions.push({
      type: "skip",
      path: keyResource.path,
      skipReason: "The development publishable key is already configured.",
    });
  else
    actions.push({
      type: keyResource.snapshot ? "modify" : "create",
      path: keyResource.path,
      content: keyResourceSource(publishableKey),
      description: "Configure the development publishable key (never a secret key)",
    });
  const postInstructions = [
    `Inspected ${inspection.build.path} and ${inspection.manifest.path} for ${selection.applicationId}. Other modules, build variants, and signing remain unverified.`,
    "Sync Gradle with a JDK 17 or newer and build the module. Existing dependency versions are preserved; SDK API compatibility has not been verified.",
  ];
  if (sdkAction.type === "skip") postInstructions.push(sdkAction.skipReason);
  else if (options.skipDependencies) postInstructions.push(options.skipDependencies);
  postInstructions.push(...notes);
  if (!initializes)
    postInstructions.push(
      `Initialize Clerk in ${application.className}: call Clerk.initialize(this, publishableKey = getString(R.string.${KEY_RESOURCE})) after super.onCreate(). Manual SDK guide: ${ANDROID_QUICKSTART}`,
    );
  postInstructions.push(
    "Native registration uses the applicationId of the build you install (the debug variant for the development instance) and the SHA-256 fingerprint of its signing certificate. Pass --android-package or --android-fingerprint when they differ from what Gradle and the debug keystore say.",
  );
  return { actions, postInstructions, sdk: sdkAction, initializes };
}
