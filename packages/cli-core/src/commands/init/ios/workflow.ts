import type { ScaffoldPlan } from "../frameworks/types.ts";
import { unlink } from "node:fs/promises";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { CliError, ERROR_CODE, errorMessage } from "../../../lib/errors.ts";
import {
  assertAbsent,
  assertUnchanged,
  createFile,
  gitDirty,
  gitTracked,
  replaceProject,
  snapshotFile,
  rollbackFiles,
  type AppliedFile,
} from "./files.ts";
import { planStarter } from "./starter.ts";
import { planAllCapabilities } from "./capabilities.ts";
import { sdkHealth, resolvedSDKHealth } from "./sdk-health.ts";
import { integrationHandoff } from "./handoff.ts";
import {
  describeIdentity,
  discoverBundleIdentifier,
  discoverRemote,
  IdentityRequired,
  type IdentityDiscovery,
  type IdentityPrompt,
  type RemoteSelection,
} from "./identity.ts";
import {
  auditIOSNativeAppleConnection,
  auditIOSNativeAppleHealth,
  applyIOSNativeAppleConnection,
  type IOSNativeAppleAPI,
  type IOSNativeApplePlan,
} from "./native-apple.ts";
import { planAppleSetup } from "./plan.ts";
import { sdkLinked } from "./sdk.ts";
import { setupError } from "./types.ts";
import {
  applyRemote,
  auditRemote,
  nativeAPI,
  revalidateRemote,
  type NativeAPI,
  type RemotePlan,
} from "./remote.ts";
import {
  inspectSelectedProject,
  resolvePackages,
  type CommandRunner,
  type Inspection,
  type InspectOptions,
} from "./xcode.ts";

export interface SetupOptions extends InspectOptions {
  remote?: RemoteSelection;
  capabilities?: boolean;
  signInWithApple?: boolean;
  signInUI?: boolean;
  starter?: boolean;
  inspectOnly?: boolean;
  checkAppleConnection?: boolean;
  /** An inspection of the same project taken earlier (say, before prompting), to avoid a second xcodebuild pass. */
  inspection?: Inspection;
}
export interface Dependencies {
  run?: CommandRunner;
  api?: NativeAPI;
  appleAPI?: IOSNativeAppleAPI;
  promptIdentity?: IdentityPrompt;
}
export interface SetupPreview {
  inspection: Inspection;
  local: ScaffoldPlan;
  remote?: RemotePlan;
  discovery?: IdentityDiscovery;
  resolvePackages: boolean;
  progress?: (message: string) => void;
  dirtyFiles: string[];
  capabilities?: Awaited<ReturnType<typeof planAllCapabilities>>;
  sdk: ScaffoldPlan["actions"][number];
  sdkCheck: ReturnType<typeof sdkHealth>;
  apple?: IOSNativeApplePlan;
  appleRequested: boolean;
  appleWarning?: string;
  signInUIRequested: boolean;
  starter?: Awaited<ReturnType<typeof planStarter>>;
}

export async function prepareSetup(
  options: SetupOptions,
  dependencies: Dependencies = {},
): Promise<SetupPreview> {
  const inspection = options.inspection
    ? { ...options.inspection, input: { ...options.inspection.input, products: options.products } }
    : await inspectSelectedProject(
        { ...options, resolvePackages: options.inspectOnly ? false : options.resolvePackages },
        dependencies.run,
      );
  const local = planAppleSetup(inspection.input);
  for (const context of inspection.contexts.slice(1))
    planAppleSetup({
      ...inspection.input,
      selection: context.selection,
      settingsJSON: context.settingsJSON,
    });
  const sdkCheck = sdkHealth(inspection.input);
  if (sdkCheck.status === "fail")
    local.actions[0] = {
      type: "skip",
      path: inspection.document.path,
      skipReason: sdkCheck.message,
    };
  local.postInstructions[0] = `Xcode inspected ${inspection.contexts.map((context) => `${context.selection.configuration}/${context.selection.sdk}`).join(", ")} for ${inspection.input.selection.targetName}. Unchecked configurations: ${inspection.uncheckedConfigurations.join(", ") || "none"}. Other platforms, signing, and source integration remain unverified.`;
  const api = dependencies.api ?? nativeAPI;
  const discovery = options.remote
    ? await discoverRemote(options.remote, inspection, api, dependencies.promptIdentity)
    : undefined;
  if (discovery && !discovery.context) throw new IdentityRequired(discovery);
  const remote = discovery?.context ? await auditRemote(discovery.context, api) : undefined;
  if (options.signInWithApple && !remote)
    throw setupError(
      "Native Apple sign-in requires an explicitly selected Clerk application and confirmed native identity.",
    );
  const originalAction = local.actions[0]!;
  let appleEnabled = options.signInWithApple === true;
  let appleWarning: string | undefined;
  if (options.checkAppleConnection && remote && !options.signInWithApple) {
    try {
      const health = await auditIOSNativeAppleHealth(
        {
          ...remote.context,
          platform: inspection.input.selection.sdk === "macosx" ? "macos" : "ios",
        },
        dependencies.appleAPI,
      );
      const enabledInClerk = health.runtime.current?.enabled === true;
      // Follow Clerk's setting only when the user wasn't asked; an explicit
      // "no" must not add the Sign in with Apple entitlement.
      if (options.signInWithApple === undefined) appleEnabled = enabledInClerk;
      if (enabledInClerk && options.signInWithApple === false)
        appleWarning =
          "Sign in with Apple is enabled for this Clerk instance, but its capability was not added. Apple sign-in fails on device until you add it, or rerun with --sign-in-with-apple.";
      else if (
        health.runtime.status === "blocked" ||
        (appleEnabled && health.runtime.status !== "satisfied")
      )
        appleWarning =
          "The enabled Apple connection needs review in Clerk; rerun with --sign-in-with-apple to review its setup.";
    } catch {
      options.signal?.throwIfAborted();
      appleWarning =
        "Apple provider settings could not be checked. Review them in Clerk or rerun setup when account access is restored.";
    }
  }
  const capabilities =
    options.capabilities || options.signInWithApple
      ? await planAllCapabilities(
          inspection,
          originalAction.type === "modify" ? originalAction.content : inspection.document.source,
          remote?.context.frontendHost,
          appleEnabled,
        )
      : undefined;
  if (capabilities) {
    if (
      capabilities.projectSource !==
      (originalAction.type === "modify" ? originalAction.content : inspection.document.source)
    )
      local.actions[0] = {
        type: "modify",
        path: inspection.document.path,
        content: capabilities.projectSource,
        description: "Update selected SDK linkage and capability settings",
      };
    local.actions.push(...capabilities.actions);
  }
  const apple =
    options.signInWithApple && capabilities?.appleEntitlement && remote
      ? await auditIOSNativeAppleConnection(
          {
            applicationId: remote.context.applicationId,
            instanceId: remote.context.instanceId,
            bundleIdentifier: remote.context.bundleIdentifier,
            platform: inspection.input.selection.sdk === "macosx" ? "macos" : "ios",
          },
          dependencies.appleAPI,
        )
      : undefined;

  if (apple?.status === "blocked")
    throw setupError(
      "The existing Apple connection needs review in Clerk before setup can proceed.",
    );
  if (options.signInUI && options.products !== "ui")
    throw setupError("Sign-in UI requires ClerkKitUI; use --apple-sdk ui.");
  const starter =
    options.starter !== false && sdkLinked(originalAction)
      ? await planStarter(inspection, remote?.context.publishableKey, options.signInUI === true)
      : undefined;
  if (starter) local.actions.push(...starter.actions);
  const { root } = inspection.input.selection;
  await assertUnchanged(root, inspection.document);
  for (const snapshot of [...(capabilities?.snapshots ?? []), ...(starter?.snapshots ?? [])])
    await assertUnchanged(root, snapshot);
  const dirtyFiles = (
    await Promise.all(
      local.actions
        .filter((action) => action.type !== "skip")
        .map(async (action) => ((await gitDirty(root, action.path)) ? action.path : undefined)),
    )
  ).filter((path): path is string => path !== undefined);
  const instructions = local.postInstructions;
  if (remote) {
    local.postInstructions = instructions.map((instruction) =>
      instruction.replace("<frontend-api-host>", remote.context.frontendHost),
    );
  } else
    instructions.push(
      "Native registration was not selected. Enable Native API and register the final Bundle ID / App ID Prefix in the Dashboard.",
    );
  if (capabilities && capabilities.status !== "manual") {
    local.postInstructions = local.postInstructions.filter(
      (instruction) =>
        !instruction.startsWith("In Signing & Capabilities,") &&
        !instruction.startsWith("Enable Outgoing Connections") &&
        !instruction.startsWith("Selected entitlement setting:") &&
        !(options.signInWithApple && instruction.startsWith("Review enabled sign-in methods")),
    );
    local.postInstructions.push(
      `Capability scope: ${capabilities.scope}. Only the listed contexts were inspected.`,
    );
  } else if (capabilities?.reason) local.postInstructions.push(capabilities.reason);
  options.signal?.throwIfAborted();
  return {
    inspection,
    local,
    remote,
    discovery,
    resolvePackages: options.resolvePackages !== false,
    progress: options.progress,
    capabilities,
    apple,
    appleRequested: options.signInWithApple === true,
    appleWarning,
    signInUIRequested: options.signInUI === true,
    starter,
    sdk: originalAction,
    sdkCheck,
    dirtyFiles,
  };
}

// This is the review surface. Raw build settings and keys are deliberately omitted.
export function describePreview(preview: SetupPreview) {
  return {
    context: preview.inspection.input.selection,
    existingGitChanges: preview.dirtyFiles,
    coverage: {
      inspected: preview.inspection.contexts.map((context) => ({
        configuration: context.selection.configuration,
        platform: context.selection.sdk,
      })),
      uncheckedConfigurations: preview.inspection.uncheckedConfigurations,
    },
    sdk: {
      linkage: preview.sdk.type === "skip" ? preview.sdk.skipReason : "Installation planned",
      version: preview.sdkCheck,
    },
    appIntegrationComplete: false,
    identity: preview.discovery ? describeIdentity(preview.discovery) : undefined,
    packageResolution: preview.resolvePackages
      ? "Xcode will resolve packages after local edits"
      : "Not requested",
    sourceIntegration: preview.starter?.tasks.length
      ? "Apply or verify the unchanged SwiftUI starter recipe"
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
          bundleIdentifier: preview.remote.context.bundleIdentifier,
          appIdPrefix: preview.remote.context.appIdPrefix,
          actions: preview.remote.actions,
        }
      : "Manual Dashboard setup",
    remaining:
      "Complete the source-integration handoff in existing app files, resolve packages, and build. Review any manual capability steps and other configurations.",
    capabilities: preview.capabilities
      ? {
          status: preview.capabilities.status,
          scope: preview.capabilities.scope,
          reason: preview.capabilities.reason,
          contexts: preview.capabilities.contexts,
        }
      : "Manual Xcode setup",
    apple: preview.apple
      ? {
          status: preview.apple.status,
          actions: preview.apple.actions,
          blockers: preview.apple.blockers,
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
  packages: "resolved" | "skipped" | "incomplete";
  apple: "verified" | "manual" | "incomplete";
  handoff: ReturnType<typeof integrationHandoff>;
  capabilities: { status: "manual" | "configured"; scope?: string; reason?: string };
  /** The native identity registered with Clerk and where its App ID Prefix came from. */
  identity?: { bundleIdentifier: string; appIdPrefix: string; prefixSource: string };
}

export async function applySetup(
  preview: SetupPreview,
  dependencies: Dependencies = {},
  signal?: AbortSignal,
): Promise<ApplyResult> {
  signal?.throwIfAborted();
  const { root } = preview.inspection.input.selection;
  const document = preview.inspection.document;
  await assertUnchanged(root, document);
  const api = dependencies.api ?? nativeAPI;
  if (preview.remote) await revalidateRemote(preview.remote, api);
  // A Bundle ID read from Xcode can come from an xcconfig the snapshots don't cover, so
  // read it again. Do it before the local edits add the Clerk package: until that
  // resolves, xcodebuild can't report settings, and registration shouldn't wait on it.
  let bundleIdentifierError: unknown;
  if (preview.remote && preview.discovery?.bundleSource === "xcode") {
    try {
      const { input, contexts } = preview.inspection;
      const current = await inspectSelectedProject(
        {
          root,
          project: input.selection.project,
          target: input.selection.targetId,
          configuration: contexts.length === 1 ? input.selection.configuration : undefined,
          sdk: input.selection.sdk,
          products: input.products,
          minimumVersion: input.minimumVersion,
          signal,
        },
        dependencies.run,
      );
      if ((await discoverBundleIdentifier(current)) !== preview.remote.context.bundleIdentifier)
        throw setupError("The Bundle ID changed after the preview; rerun clerk init.", true);
    } catch (error) {
      if (signal?.aborted) throw error;
      bundleIdentifierError = error;
    }
  }
  const snapshots = [
    document,
    ...(preview.capabilities?.snapshots ?? []),
    ...(preview.starter?.snapshots ?? []),
  ];
  const actions = preview.local.actions.filter((action) => action.type !== "skip");
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
    packages: "skipped",
    apple: "manual",
    remote: "manual",
    instructions: preview.local.postInstructions,
    handoff: integrationHandoff(
      preview.inspection.input.selection,
      preview.inspection.input.products,
      preview.remote?.context.publishableKey,
    ),
    capabilities: {
      status: "manual",
      scope: preview.capabilities?.scope,
      reason: preview.capabilities?.reason,
    },
    ...(preview.remote && preview.discovery
      ? {
          identity: {
            bundleIdentifier: preview.remote.context.bundleIdentifier,
            appIdPrefix: preview.remote.context.appIdPrefix,
            prefixSource: preview.discovery.prefixSource,
          },
        }
      : {}),
  };
  let sdkCheck = preview.sdkCheck;
  const finish = () => {
    const completed: { id: string; detail: string }[] = [];
    const remaining: { id: string; detail: string }[] = [];
    const step = (id: string, done: boolean, detail: string) =>
      (done ? completed : remaining).push({ id, detail });
    const linked = sdkLinked(preview.sdk);
    step(
      "sdk-linkage",
      result.local !== "incomplete" && linked,
      result.local === "incomplete"
        ? "Local writes stopped; inspect changedFiles and backups before retrying."
        : linked
          ? "Requested SDK products are linked in the project. Package resolution and compilation remain unverified."
          : preview.sdk.type === "skip"
            ? preview.sdk.skipReason
            : "SDK installation remains incomplete.",
    );
    step(
      "native-registration",
      result.remote === "verified",
      result.remote === "verified"
        ? "Confirmed native identity is registered and Native API is enabled."
        : "Complete or reconcile native registration in Clerk.",
    );
    if (preview.capabilities)
      for (const context of preview.capabilities.contexts)
        step(
          `capabilities: ${context.scope}`,
          result.local !== "incomplete" && context.status !== "manual",
          context.reason ??
            (result.local === "incomplete"
              ? "Capability edits require review after interrupted local setup."
              : "The requested capability settings are configured; signing remains unverified."),
        );
    else
      remaining.push({
        id: "capabilities",
        detail: "Capabilities were not configured by this invocation; review them in Xcode.",
      });
    if (preview.appleRequested)
      step(
        "native-apple",
        result.apple === "verified",
        result.apple === "verified"
          ? "Native Apple sign-in is enabled for the confirmed Bundle ID."
          : "Apple provider activation is incomplete; review Clerk settings and local entitlements.",
      );
    if (preview.appleWarning)
      remaining.push({ id: "apple-provider-review", detail: preview.appleWarning });
    if (sdkCheck.status === "fail" || (preview.sdk.type === "skip" && sdkCheck.status !== "pass"))
      remaining.push({ id: "sdk-version", detail: sdkCheck.message });
    if (preview.resolvePackages)
      step(
        "swift-packages",
        result.packages === "resolved",
        result.packages === "resolved"
          ? "Xcode resolved Swift package dependencies. Compilation remains unverified."
          : "Swift package resolution remains incomplete; retry setup after checking Xcode's network and private-package access.",
      );
    for (const configuration of preview.inspection.uncheckedConfigurations)
      remaining.push({
        id: `configuration: ${configuration}`,
        detail:
          "This configuration was not inspected. Run setup with --xcode-configuration to review it.",
      });
    if (result.local !== "incomplete")
      for (const id of preview.starter?.tasks ?? [])
        completed.push({
          id,
          detail:
            "Applied or verified the starter recipe in the existing app files; compilation remains unverified.",
        });
    const incomplete = [result.local, result.remote, result.apple, result.packages].includes(
      "incomplete",
    );
    result.status = incomplete
      ? "incomplete"
      : remaining.length
        ? "manual-steps-required"
        : preview.starter?.tasks.length
          ? "requires-build-and-verification"
          : "requires-source-integration";
    if (result.local !== "incomplete" && preview.starter?.tasks.length) {
      result.instructions.push(
        "The recognized starter's Clerk source setup is configured. Make one Debug build; runtime testing requires an explicit user request.",
      );
    }
    if (result.packages === "resolved")
      result.instructions = result.instructions.map((instruction) =>
        instruction.startsWith("Resolve Swift packages and build")
          ? "Swift packages are resolved. Build the selected target in Xcode; source compilation remains unverified."
          : instruction,
      );
    result.handoff = integrationHandoff(
      preview.inspection.input.selection,
      preview.inspection.input.products,
      preview.remote?.context.publishableKey,
      {
        cliStatus: incomplete
          ? "incomplete"
          : remaining.length
            ? "manual-steps-required"
            : "complete",
        completed,
        remaining,
        changedFiles: result.changedFiles,
        signInUIRequested: preview.signInUIRequested,
        configurations: preview.inspection.contexts.map(
          (context) => context.selection.configuration,
        ),
        xcode: {
          developerDir: preview.inspection.settings.DEVELOPER_DIR,
          projectFormat: preview.inspection.input.projectFormat,
        },
      },
    );
    return result;
  };
  const applied: AppliedFile[] = [];
  const messages: string[] = [];
  const backups = new Map<string, string>();
  try {
    // Entitlement file first, project reference last. Each write is recoverable;
    // this is deliberately not a durable transaction across several files.
    for (const action of [
      ...actions.filter((item) => item.path !== document.path),
      ...actions.filter((item) => item.path === document.path),
    ]) {
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
  if (preview.capabilities && preview.capabilities.status !== "manual")
    result.capabilities.status = "configured";
  if (preview.resolvePackages && sdkLinked(preview.sdk)) {
    try {
      await resolvePackages(
        root,
        preview.inspection.input.selection.project,
        dependencies.run,
        signal,
        preview.progress,
      );
      result.packages = "resolved";
      sdkCheck = (await resolvedSDKHealth(preview.inspection.input)) ?? sdkCheck;
    } catch (error) {
      if (signal?.aborted) throw error;
      // Registration doesn't depend on packages, so carry on and report both.
      result.packages = "incomplete";
      messages.push(errorMessage(error));
    }
  }
  const revalidateLocal = async () => {
    signal?.throwIfAborted();
    for (const snapshot of snapshots) {
      const action = actions.find((item) => item.path === snapshot.path);
      if (!action) await assertUnchanged(root, snapshot);
      else if ((await snapshotFile(root, snapshot.path)).source !== action.content)
        throw setupError("Local setup changed before remote registration.", true);
    }
    for (const action of actions.filter((item) => item.type === "create"))
      if ((await snapshotFile(root, action.path)).source !== action.content)
        throw setupError("New local files changed before remote registration.", true);
  };
  if (preview.remote) {
    try {
      await revalidateLocal();
      if (bundleIdentifierError) throw bundleIdentifierError;
      await applyRemote(preview.remote, api, signal);
      result.remote = "verified";
    } catch (error) {
      if (signal?.aborted) throw error;
      result.remote = "incomplete";
      messages.push(
        `Clerk native registration is incomplete: ${errorMessage(error)} Local edits remain; rerun setup with the same application to reconcile.`,
      );
    }
  }
  if (preview.apple && result.remote === "verified") {
    try {
      // Native registration may advance the config version, so re-audit and
      // apply only if the Apple connection is still what the user approved.
      const apple = await auditIOSNativeAppleConnection(preview.apple, dependencies.appleAPI);
      if (
        apple.status !== "satisfied" &&
        (apple.status !== "ready" ||
          preview.apple.status !== "ready" ||
          !isDeepStrictEqual(apple.current, preview.apple.current) ||
          apple.bundleIdentifierConfiguration !== preview.apple.bundleIdentifierConfiguration)
      )
        throw new CliError("The Apple connection changed after the preview; rerun clerk init.", {
          code: ERROR_CODE.IOS_SETUP_STALE,
        });
      await applyIOSNativeAppleConnection(apple, {
        api: dependencies.appleAPI,
        revalidateLocalPreconditions: revalidateLocal,
      });
      result.apple = "verified";
    } catch (error) {
      if (signal?.aborted) throw error;
      result.apple = "incomplete";
      messages.push(`Sign in with Apple was not configured: ${errorMessage(error)}`);
    }
  }
  if (messages.length) result.message = messages.join("\n");
  return finish();
}
