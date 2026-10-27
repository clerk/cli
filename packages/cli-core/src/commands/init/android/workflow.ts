import type { FileAction } from "../frameworks/types.ts";
import { unlink } from "node:fs/promises";
import { join } from "node:path";
import { CliError, ERROR_CODE, errorMessage } from "../../../lib/errors.ts";
import { isDeepStrictEqual } from "node:util";
import {
  assertAbsent,
  assertUnchanged,
  createFile,
  gitDirty,
  gitTracked,
  removeEmptyBackupFolders,
  replaceProject,
  rollbackFiles,
  snapshotFile,
  type AppliedFile,
  type FileSnapshot,
} from "./files.ts";
import { integrationHandoff } from "./handoff.ts";
import {
  describeIdentity,
  discoverIdentity,
  IdentityRequired,
  readDebugKeystore,
  type DebugKeystoreReader,
  type IdentityDiscovery,
} from "./identity.ts";
import {
  applyGoogleConnection,
  auditGoogleConnection,
  auditGoogleHealth,
  googleCloudSteps,
  type GoogleAPI,
  type GoogleCredentials,
  type GooglePlan,
} from "./native-google.ts";
import { planAndroidSetup, writes, type AndroidPlan } from "./plan.ts";
import { inspectAndroidProject, type Inspection, type InspectOptions } from "./project.ts";
import {
  applyRemote,
  auditRemote,
  nativeAPI,
  resolveInstance,
  revalidateRemote,
  type NativeAPI,
  type RemotePlan,
} from "./remote.ts";
import {
  CLERK_ANDROID_KOTLIN_MINIMUM,
  kotlinHealth,
  sdkHealth,
  sdkInstalled,
  type Check,
} from "./sdk.ts";
import { setupError } from "./types.ts";

export interface RemoteSelection {
  applicationId: string;
  instanceId?: string;
}

export interface SetupOptions extends InspectOptions {
  remote?: RemoteSelection;
  /** Fingerprints passed with --android-fingerprint, in any accepted spelling. */
  fingerprints?: string[];
  /** Whether to read the debug keystore; a dry run or doctor without keytool leaves it out. */
  readDebugKeystore?: boolean;
  /** Configure Clerk's Google connection for native Sign in with Google; false declines. */
  signInWithGoogle?: boolean;
  /** The Google Web client, when the connection has none yet. Never reported back. */
  googleCredentials?: GoogleCredentials;
  /** Read the Google connection when Sign in with Google wasn't asked for, to warn about it. */
  checkGoogleConnection?: boolean;
  inspectOnly?: boolean;
  progress?: (message: string) => void;
  /** An inspection of the same project taken earlier (say, before prompting). */
  inspection?: Inspection;
}
export interface Dependencies {
  api?: NativeAPI;
  googleAPI?: GoogleAPI;
  /** Reads the debug certificate, instead of running keytool. */
  debugKeystore?: DebugKeystoreReader;
}
export interface SetupPreview {
  inspection: Inspection;
  local: AndroidPlan;
  remote?: RemotePlan;
  identity?: IdentityDiscovery;
  progress?: (message: string) => void;
  dirtyFiles: string[];
  sdk: FileAction;
  sdkCheck: Check;
  kotlinCheck: Check;
  /** The development publishable key the plan writes, once an application is chosen. */
  publishableKey?: string;
  google?: GooglePlan;
  googleRequested: boolean;
  googleWarning?: string;
  /** Held for apply only; never described or reported. */
  googleCredentials?: GoogleCredentials;
  /** What only the user can do in Google Cloud, with this project's values. */
  googleCloudSteps?: string[];
}

/** Sign in with Google needs the Web client's ID and secret, which only the user has. */
export class GoogleCredentialsRequired extends CliError {
  constructor(
    public plan: GooglePlan,
    public identity: IdentityDiscovery,
    public steps: string[],
    public frontendHost: string,
  ) {
    super(
      "Native Sign in with Google needs the Google Web client ID and secret: pass --google-client-id and --google-client-secret-file (a path, or - for standard input), or rerun clerk init at a terminal to be asked for them.",
      { code: ERROR_CODE.USAGE_ERROR, exitCode: 2 },
    );
  }
}

/** The files a plan may rewrite, as inspected. */
export function planSnapshots(inspection: Inspection): FileSnapshot[] {
  return [
    inspection.build,
    inspection.manifest,
    ...(inspection.catalog ? [inspection.catalog] : []),
    ...(inspection.application.source ? [inspection.application.source] : []),
    ...(inspection.keyResource.snapshot ? [inspection.keyResource.snapshot] : []),
  ];
}

export async function prepareSetup(
  options: SetupOptions,
  dependencies: Dependencies = {},
): Promise<SetupPreview> {
  const inspection =
    options.inspection && options.inspection.sdk === options.sdk
      ? options.inspection
      : await inspectAndroidProject(options);
  const api = dependencies.api ?? nativeAPI;
  const sdkCheck = sdkHealth(inspection.dependencies, inspection.minimumVersion);
  const kotlinCheck = kotlinHealth(inspection.kotlin, CLERK_ANDROID_KOTLIN_MINIMUM);
  if (kotlinCheck.status === "fail" && !options.inspectOnly)
    throw setupError(`${kotlinCheck.message} ${kotlinCheck.remedy ?? ""}`.trim());
  // The instance first: its key is part of the local plan, and a wrong link should stop early.
  const instance = options.remote ? await resolveInstance(options.remote, api) : undefined;
  const identity = options.remote
    ? await discoverIdentity(
        inspection.selection,
        options.fingerprints,
        options.readDebugKeystore === false
          ? false
          : (dependencies.debugKeystore ?? readDebugKeystore),
        options.signal,
      )
    : undefined;
  const remote =
    instance && identity
      ? await auditRemote(
          {
            ...instance,
            packageName: identity.applicationId,
            fingerprints: identity.fingerprints,
          },
          api,
        )
      : undefined;
  // Registering needs a fingerprint: assetlinks.json, which passkeys need, is served from them.
  if (remote?.actions.includes("register-application") && !identity!.fingerprints.length)
    throw new IdentityRequired(identity!);
  if (options.signInWithGoogle && !remote)
    throw setupError(
      "Native Sign in with Google requires an explicitly selected Clerk application.",
    );
  const steps =
    remote && identity
      ? googleCloudSteps({
          packageName: identity.applicationId,
          sha1: identity.debug.sha1,
          frontendHost: remote.context.frontendHost,
        })
      : undefined;
  let google: GooglePlan | undefined;
  let googleWarning: string | undefined;
  if (options.signInWithGoogle && remote && identity) {
    google = await auditGoogleConnection(
      { applicationId: remote.context.applicationId, instanceId: remote.context.instanceId },
      dependencies.googleAPI,
    );
    if (google.status === "blocked")
      throw setupError(
        `The Google connection needs review in Clerk before setup can proceed: ${google.blockers.map((blocker) => blocker.message).join(" ")}`,
      );
    if (
      google.status === "ready" &&
      google.credentials === "required" &&
      !options.googleCredentials
    )
      throw new GoogleCredentialsRequired(google, identity, steps!, remote.context.frontendHost);
  } else if (options.checkGoogleConnection && remote && !options.signInWithGoogle) {
    try {
      const healthCheck = await auditGoogleHealth(
        { applicationId: remote.context.applicationId, instanceId: remote.context.instanceId },
        dependencies.googleAPI,
      );
      // Google on without a Web client is the one state that fails silently on device: the SDK
      // needs the client ID Clerk serves as the One Tap client ID.
      if (healthCheck.current?.enabled && healthCheck.credentials === "required")
        googleWarning =
          options.signInWithGoogle === false
            ? "Google is enabled for this Clerk instance but has no Web client ID, and Sign in with Google was declined. Native Google sign-in fails on Android until a Web client is configured; rerun with --sign-in-with-google."
            : "Google is enabled for this Clerk instance but has no Web client ID. Native Google sign-in fails on Android until a Web client is configured; rerun with --sign-in-with-google.";
      else if (healthCheck.status === "blocked")
        googleWarning =
          "The enabled Google connection needs review in Clerk; rerun with --sign-in-with-google to review its setup.";
    } catch {
      options.signal?.throwIfAborted();
      googleWarning =
        "Google provider settings could not be checked. Review them in Clerk or rerun setup when account access is restored.";
    }
  }
  // An SDK below the baseline is reported, not replaced: the dependency lines and their catalog
  // entries stay out, while the rest of the build-script plan (the minSdk raise) still applies.
  const local = planAndroidSetup(
    inspection,
    instance?.publishableKey,
    sdkCheck.status === "fail" ? { skipDependencies: sdkCheck.message } : {},
  );
  const { root } = inspection.selection;
  for (const snapshot of planSnapshots(inspection)) await assertUnchanged(root, snapshot);
  const dirtyFiles = (
    await Promise.all(
      local.actions
        .filter(writes)
        .map(async (action) => ((await gitDirty(root, action.path)) ? action.path : undefined)),
    )
  ).filter((path): path is string => path !== undefined);
  if (!remote)
    local.postInstructions.push(
      "Native registration was not selected. Enable Native API and register the applicationId and signing fingerprints on the Native Applications page.",
    );
  if (remote?.blocker) local.postInstructions.push(remote.blocker);
  if (identity?.debug.status !== "found" && identity?.issues.length)
    local.postInstructions.push(...identity.issues);
  if (kotlinCheck.status !== "pass") local.postInstructions.push(kotlinCheck.message);
  options.signal?.throwIfAborted();
  return {
    inspection,
    local,
    remote,
    identity,
    progress: options.progress,
    dirtyFiles,
    sdk: local.sdk,
    sdkCheck,
    kotlinCheck,
    publishableKey: instance?.publishableKey,
    google,
    googleRequested: options.signInWithGoogle === true,
    googleWarning,
    googleCredentials: options.googleCredentials,
    googleCloudSteps: options.signInWithGoogle ? steps : undefined,
  };
}

// This is the review surface. Keys are deliberately omitted.
export function describePreview(preview: SetupPreview) {
  const { selection } = preview.inspection;
  return {
    context: {
      root: selection.root,
      module: selection.module,
      namespace: selection.namespace,
      applicationId: selection.applicationId,
      applicationIdSource: selection.applicationIdSource,
      sdk: preview.inspection.sdk,
    },
    existingGitChanges: preview.dirtyFiles,
    coverage: {
      inspected: [preview.inspection.build.path, preview.inspection.manifest.path],
      minSdk: preview.inspection.minSdk.value,
      kotlin: preview.inspection.kotlin.version ?? preview.inspection.kotlin.source,
      agp: preview.inspection.agp.version,
    },
    sdk: {
      dependency: preview.sdk.type === "skip" ? preview.sdk.skipReason : "Installation planned",
      version: preview.sdkCheck,
      kotlin: preview.kotlinCheck,
    },
    appIntegrationComplete: false,
    identity: preview.identity ? describeIdentity(preview.identity) : undefined,
    sourceIntegration: preview.local.initializes
      ? "Clerk is initialized in the Application subclass"
      : "Complete the source-integration handoff",
    files: preview.local.actions.map((action) =>
      action.type === "skip"
        ? { path: action.path, status: action.skipReason }
        : { path: action.path, status: action.description },
    ),
    remote: preview.remote
      ? {
          application: preview.remote.context.applicationId,
          instance: preview.remote.context.instanceId,
          packageName: preview.remote.context.packageName,
          fingerprints: preview.remote.context.fingerprints,
          actions: preview.remote.actions,
          ...(preview.remote.blocker ? { blocker: preview.remote.blocker } : {}),
        }
      : "Manual Dashboard setup",
    remaining:
      "Complete the source-integration handoff in existing app files and build the module. Review any manual steps.",
    google: preview.google
      ? {
          status: preview.google.status,
          credentials: preview.google.credentials,
          actions: preview.google.actions,
          blockers: preview.google.blockers,
          ...(preview.googleCloudSteps ? { googleCloudSteps: preview.googleCloudSteps } : {}),
        }
      : "Not planned",
  };
}

export interface ApplyResult {
  status:
    | "incomplete"
    | "manual-steps-required"
    | "requires-source-integration"
    | "requires-build-and-verification";
  appIntegrationComplete: false;
  local: "updated" | "unchanged" | "incomplete";
  remote: "verified" | "manual" | "incomplete";
  instructions: string[];
  message?: string;
  backups: string[];
  changedFiles: string[];
  recovery?: { restored: string[]; needsReview: string[] };
  google: "verified" | "manual" | "incomplete";
  handoff: ReturnType<typeof integrationHandoff>;
  /** The native identity registered with Clerk and where its fingerprints came from. */
  identity?: ReturnType<typeof describeIdentity>;
}

export async function applySetup(
  preview: SetupPreview,
  dependencies: Dependencies = {},
  signal?: AbortSignal,
): Promise<ApplyResult> {
  signal?.throwIfAborted();
  const { root } = preview.inspection.selection;
  const snapshots = planSnapshots(preview.inspection);
  for (const snapshot of snapshots) await assertUnchanged(root, snapshot);
  const api = dependencies.api ?? nativeAPI;
  if (preview.remote) await revalidateRemote(preview.remote, api);
  const actions = preview.local.actions.filter(writes);
  for (const action of actions) {
    if (action.type === "create") await assertAbsent(root, action.path);
    else {
      const snapshot = snapshots.find((item) => item.path === action.path);
      if (!snapshot) throw setupError("Review a fresh setup plan.", true);
      await assertUnchanged(root, snapshot);
    }
  }
  const result: ApplyResult = {
    status: "incomplete",
    appIntegrationComplete: false,
    local: "unchanged",
    backups: [],
    changedFiles: [],
    remote: "manual",
    google: "manual",
    instructions: preview.local.postInstructions,
    handoff: integrationHandoff(
      preview.inspection.selection,
      preview.inspection.sdk,
      preview.publishableKey,
    ),
    ...(preview.identity ? { identity: describeIdentity(preview.identity) } : {}),
  };
  const finish = () => {
    const completed: { id: string; detail: string }[] = [];
    const remaining: { id: string; detail: string }[] = [];
    const step = (id: string, done: boolean, detail: string) =>
      (done ? completed : remaining).push({ id, detail });
    const installed =
      preview.sdk.type !== "skip" ||
      sdkInstalled(preview.inspection.dependencies, preview.inspection.sdk);
    step(
      "sdk-dependency",
      result.local !== "incomplete" && installed,
      result.local === "incomplete"
        ? "Local writes stopped; inspect changedFiles and backups before retrying."
        : installed
          ? "The requested Clerk SDK dependency is declared. Gradle sync and compilation remain unverified."
          : preview.sdk.type === "skip"
            ? preview.sdk.skipReason
            : "SDK installation remains incomplete.",
    );
    step(
      "initialize-clerk",
      result.local !== "incomplete" && preview.local.initializes,
      result.local === "incomplete"
        ? "Source edits require review after interrupted local setup."
        : preview.local.initializes
          ? "The registered Application subclass initializes Clerk with the development publishable key resource."
          : (preview.inspection.application.reason ??
            "Initialize Clerk in the registered Application subclass."),
    );
    step(
      "native-registration",
      result.remote === "verified",
      result.remote === "verified"
        ? "The applicationId and signing fingerprints are registered and Native API is enabled."
        : (preview.remote?.blocker ?? "Complete or reconcile native registration in Clerk."),
    );
    if (preview.identity?.debug.status !== "found" && preview.identity?.issues.length)
      remaining.push({ id: "debug-fingerprint", detail: preview.identity.issues.join(" ") });
    if (preview.sdkCheck.status === "fail")
      remaining.push({ id: "sdk-version", detail: preview.sdkCheck.message });
    if (preview.kotlinCheck.status !== "pass")
      remaining.push({ id: "kotlin-version", detail: preview.kotlinCheck.message });
    if (preview.googleRequested)
      step(
        "native-google",
        result.google === "verified",
        result.google === "verified"
          ? "Google is enabled for authentication with a Web client ID; the Android SDK reads it as the One Tap client ID."
          : "The Google connection is incomplete; review Clerk settings and rerun clerk init --sign-in-with-google.",
      );
    if (preview.googleWarning)
      remaining.push({ id: "google-provider-review", detail: preview.googleWarning });
    const incomplete = [result.local, result.remote, result.google].includes("incomplete");
    result.status = incomplete
      ? "incomplete"
      : remaining.length
        ? "manual-steps-required"
        : "requires-build-and-verification";
    result.handoff = integrationHandoff(
      preview.inspection.selection,
      preview.inspection.sdk,
      preview.publishableKey,
      {
        cliStatus: incomplete
          ? "incomplete"
          : remaining.length
            ? "manual-steps-required"
            : "complete",
        completed,
        remaining,
        changedFiles: result.changedFiles,
        ...(preview.googleCloudSteps ? { google: { steps: preview.googleCloudSteps } } : {}),
      },
    );
    return result;
  };
  const applied: AppliedFile[] = [];
  const backups = new Map<string, string>();
  try {
    // Each write is recoverable; this is deliberately not a durable transaction across files.
    for (const action of actions) {
      signal?.throwIfAborted();
      if (action.type === "create") await createFile(root, action.path, action.content);
      else {
        const backup = await replaceProject(
          root,
          snapshots.find((item) => item.path === action.path)!,
          action.content,
        );
        if (backup) backups.set(action.path, backup);
      }
      result.changedFiles.push(action.path);
      result.local = "updated";
      const after = await snapshotFile(root, action.path);
      if (after.source !== action.content)
        throw setupError("A written file changed during setup.", true);
      applied.push({ before: snapshots.find((item) => item.path === action.path), after });
    }
  } catch (error) {
    result.backups = [...backups.values()];
    result.local = "incomplete";
    result.recovery = await rollbackFiles(root, applied);
    result.changedFiles = result.changedFiles.filter(
      (path) => !result.recovery!.restored.includes(path),
    );
    result.recovery.needsReview = [
      ...new Set([...result.recovery.needsReview, ...result.changedFiles]),
    ];
    if (signal?.aborted) throw error;
    result.message = `Local setup stopped (${errorMessage(error)}). Earlier edits were restored where unchanged; review recovery.needsReview and backups for any files requiring attention. No remote changes were attempted.`;
    return finish();
  }
  // Git restores tracked files that were clean before setup; keep backups for
  // everything else (uncommitted changes, untracked or ignored files, no Git).
  for (const [path, backup] of backups) {
    if (!preview.dirtyFiles.includes(path) && (await gitTracked(root, path)))
      await unlink(join(root, backup));
    else result.backups.push(backup);
  }
  if (!result.backups.length) await removeEmptyBackupFolders(root);
  if (preview.remote) {
    try {
      signal?.throwIfAborted();
      for (const snapshot of snapshots) {
        const action = actions.find((item) => item.path === snapshot.path);
        if (!action) await assertUnchanged(root, snapshot);
        else if ((await snapshotFile(root, snapshot.path)).source !== action.content)
          throw setupError("Local setup changed before remote registration.", true);
      }
      result.remote = await applyRemote(preview.remote, api, signal);
      if (result.remote === "manual") result.message = preview.remote.blocker;
    } catch (error) {
      if (signal?.aborted) throw error;
      result.remote = "incomplete";
      result.message = `Clerk native registration is incomplete: ${errorMessage(error)} Local edits remain; rerun setup with the same application to reconcile.`;
    }
  }
  if (preview.google && result.remote === "verified") {
    try {
      // Native registration may advance the config version, so re-audit and apply only if the
      // Google connection is still what the user approved.
      const google = await auditGoogleConnection(preview.google, dependencies.googleAPI);
      if (
        google.status !== "satisfied" &&
        (google.status !== "ready" ||
          preview.google.status !== "ready" ||
          google.credentials !== preview.google.credentials ||
          !isDeepStrictEqual(google.current, preview.google.current))
      )
        throw setupError(
          "The Google connection changed after the preview; rerun clerk init.",
          true,
        );
      await applyGoogleConnection(google, preview.googleCredentials, {
        api: dependencies.googleAPI,
        revalidateLocalPreconditions: async () => {
          signal?.throwIfAborted();
          for (const snapshot of snapshots) {
            const action = actions.find((item) => item.path === snapshot.path);
            if (!action) await assertUnchanged(root, snapshot);
            else if ((await snapshotFile(root, snapshot.path)).source !== action.content)
              throw setupError(
                "Local setup changed before the Google connection was written.",
                true,
              );
          }
        },
      });
      result.google = "verified";
    } catch (error) {
      if (signal?.aborted) throw error;
      result.google = "incomplete";
      result.message = [
        result.message,
        `Sign in with Google was not configured: ${errorMessage(error)}`,
      ]
        .filter(Boolean)
        .join("\n");
    }
  }
  return finish();
}
