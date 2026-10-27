import type { FileAction } from "../frameworks/types.ts";
import { unlink } from "node:fs/promises";
import { join } from "node:path";
import { errorMessage } from "../../../lib/errors.ts";
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
  inspectOnly?: boolean;
  progress?: (message: string) => void;
  /** An inspection of the same project taken earlier (say, before prompting). */
  inspection?: Inspection;
}
export interface Dependencies {
  api?: NativeAPI;
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
    const incomplete = [result.local, result.remote].includes("incomplete");
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
  return finish();
}
