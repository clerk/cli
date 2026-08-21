import { lstat, readFile } from "node:fs/promises";
import { basename, dirname, relative, resolve } from "node:path";
import { pathIsSafelyWithinIOSRoot, relativeIOSPath } from "./discovery.ts";
import {
  applyIOSFileTransaction,
  hashIOSFileBytes,
  type IOSExistingFileMutation,
} from "./file-transaction.ts";
import { hasExactIOSSwiftUIAppContentRoot } from "./direct-config.ts";
import { inspectIOSProject, inspectIOSSourceMembership } from "./inspect.ts";
import type { IOSBuildConfiguration } from "./types.ts";

const MAX_SWIFT_FILE_BYTES = 1_000_000;

export interface IOSPrebuiltAuthPlanOptions {
  root: string;
  projectPath: string;
  targetId: string;
  allowDirty?: boolean;
}

export type IOSPrebuiltAuthBlockerCode =
  | "invalid-selection"
  | "target-not-found"
  | "generated-project"
  | "incompatible-deployment-target"
  | "incomplete-source-membership"
  | "ambiguous-entry-point"
  | "unsupported-app-structure"
  | "missing-placeholder"
  | "shared-source"
  | "unreadable-source"
  | "unsupported-encoding"
  | "unsupported-line-endings"
  | "existing-auth-integration"
  | "existing-authentication-flow"
  | "runtime-prerequisites"
  | "dirty-source"
  | "git-state-unknown";

export interface IOSPrebuiltAuthBlocker {
  code: IOSPrebuiltAuthBlockerCode;
  message: string;
}

/** A redacted, serializable semantic source plan. */
export interface IOSPrebuiltAuthPlan {
  schemaVersion: 1;
  kind: "clerk-ios-prebuilt-auth";
  status: "ready" | "satisfied" | "blocked";
  root: string;
  projectPath: string;
  targetId: string;
  allowDirty: boolean;
  appSourcePath?: string;
  expectedAppSourceHash?: string;
  sourcePath?: string;
  expectedSourceHash?: string;
  actions: string[];
  blockers: IOSPrebuiltAuthBlocker[];
}

/** @internal Candidate bytes are hidden from ordinary serialization. */
export interface IOSPrebuiltAuthFileMutation {
  absolutePath: string;
  expectedHash: string;
  candidateHash: string;
  mode: number;
  originalBytes: Uint8Array;
  candidateBytes: Uint8Array;
}

export type PreparedIOSPrebuiltAuthMutation =
  | {
      status: "ready";
      plan: IOSPrebuiltAuthPlan;
      mutation: IOSPrebuiltAuthFileMutation;
    }
  | {
      status: "satisfied" | "blocked" | "stale";
      plan: IOSPrebuiltAuthPlan;
      message?: string;
      mutation?: undefined;
    };

export interface IOSPrebuiltAuthApplyResult {
  status: "applied" | "satisfied" | "blocked" | "stale" | "rolled-back";
  plan: IOSPrebuiltAuthPlan;
  message?: string;
}

interface SourceSnapshot {
  absolutePath: string;
  relativePath: string;
  bytes: Uint8Array;
  source: string;
  hash: string;
  mode: number;
  device: number;
  inode: number;
  newline: "\n" | "\r\n";
}

interface PreparedPlan {
  plan: IOSPrebuiltAuthPlan;
  appSnapshot?: SourceSnapshot;
  sourceSnapshot?: SourceSnapshot;
  sourceHeader?: string;
}

const preparedValidators = new WeakMap<PreparedIOSPrebuiltAuthMutation, () => Promise<boolean>>();

function makePlan(
  options: IOSPrebuiltAuthPlanOptions,
  root: string,
  projectPath: string,
  status: IOSPrebuiltAuthPlan["status"],
  details: Partial<
    Pick<
      IOSPrebuiltAuthPlan,
      | "appSourcePath"
      | "expectedAppSourceHash"
      | "sourcePath"
      | "expectedSourceHash"
      | "actions"
      | "blockers"
    >
  > = {},
): IOSPrebuiltAuthPlan {
  return {
    schemaVersion: 1,
    kind: "clerk-ios-prebuilt-auth",
    status,
    root,
    projectPath,
    targetId: options.targetId,
    allowDirty: options.allowDirty === true,
    appSourcePath: details.appSourcePath,
    expectedAppSourceHash: details.expectedAppSourceHash,
    sourcePath: details.sourcePath,
    expectedSourceHash: details.expectedSourceHash,
    actions: details.actions ?? [],
    blockers: details.blockers ?? [],
  };
}

function blocked(
  options: IOSPrebuiltAuthPlanOptions,
  root: string,
  projectPath: string,
  code: IOSPrebuiltAuthBlockerCode,
  message: string,
  details: Partial<
    Pick<
      IOSPrebuiltAuthPlan,
      "appSourcePath" | "expectedAppSourceHash" | "sourcePath" | "expectedSourceHash"
    >
  > = {},
): PreparedPlan {
  return {
    plan: makePlan(options, root, projectPath, "blocked", {
      ...details,
      blockers: [{ code, message }],
    }),
  };
}

function newlineStyle(source: string): "\n" | "\r\n" | undefined {
  if (/\r(?!\n)/.test(source)) return undefined;
  const hasCRLF = source.includes("\r\n");
  const hasBareLF = /(^|[^\r])\n/.test(source);
  if (hasCRLF && hasBareLF) return undefined;
  return hasCRLF ? "\r\n" : "\n";
}

function decodeUTF8(bytes: Uint8Array): string | undefined {
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    return undefined;
  }
}

async function sourceSnapshot(
  root: string,
  relativePath: string,
): Promise<SourceSnapshot | undefined> {
  const absolutePath = resolve(root, relativePath);
  if (!(await pathIsSafelyWithinIOSRoot(root, absolutePath))) return undefined;
  try {
    const info = await lstat(absolutePath);
    if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_SWIFT_FILE_BYTES) {
      return undefined;
    }
    const bytes = new Uint8Array(await readFile(absolutePath));
    const source = decodeUTF8(bytes);
    if (source == null || source.includes("\0")) return undefined;
    const newline = newlineStyle(source);
    if (!newline) return undefined;
    return {
      absolutePath,
      relativePath,
      bytes,
      source,
      hash: hashIOSFileBytes(bytes),
      mode: info.mode & 0o7777,
      device: info.dev,
      inode: info.ino,
      newline,
    };
  } catch {
    return undefined;
  }
}

async function generatedProjectKind(
  root: string,
  absoluteProjectPath: string,
): Promise<"xcodegen" | "tuist" | null> {
  let directory = dirname(absoluteProjectPath);
  while (await pathIsSafelyWithinIOSRoot(root, directory)) {
    for (const [markerPath, kind] of [
      ["project.yml", "xcodegen"],
      ["Project.swift", "tuist"],
      ["Workspace.swift", "tuist"],
      ["Tuist/ProjectDescriptionHelpers", "tuist"],
    ] as const) {
      const marker = resolve(directory, markerPath);
      if ((await pathIsSafelyWithinIOSRoot(root, marker)) && (await Bun.file(marker).exists())) {
        return kind;
      }
    }
    if (directory === root) break;
    const parent = dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  return null;
}

function splitHeader(source: string): { header: string; body: string } | undefined {
  const importMatch = /^[\t ]*import[\t ]+(?:ClerkKit|ClerkKitUI|SwiftUI)[\t ]*$/m.exec(source);
  if (importMatch?.index == null) return undefined;
  const header = source.slice(0, importMatch.index);
  const validHeader = header
    .split(/\r?\n/)
    .every((line) => line.trim() === "" || line.trimStart().startsWith("//"));
  if (!validHeader || header.includes("/*")) return undefined;
  return { header, body: source.slice(importMatch.index) };
}

function compactSwift(source: string): string | undefined {
  let result = "";
  let inString = false;
  let escaped = false;
  for (let cursor = 0; cursor < source.length; cursor += 1) {
    const character = source[cursor] ?? "";
    if (inString) {
      result += character;
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') {
      inString = true;
      result += character;
    } else if (!/\s/.test(character)) {
      result += character;
    }
  }
  return inString ? undefined : result;
}

function supportsPrebuiltAuthDeploymentTarget(value: string): boolean {
  const match = /^(\d+)(?:\.(\d+))?(?:\.(\d+))?$/.exec(value.trim());
  if (!match) return false;
  const components = match.slice(1).map((component) => Number(component ?? "0"));
  if (components.some((component) => !Number.isSafeInteger(component))) return false;
  return (components[0] ?? 0) >= 17;
}

function targetSupportsPrebuiltAuth(configurations: IOSBuildConfiguration[]): boolean {
  return (
    configurations.length > 0 &&
    configurations.every(
      (configuration) =>
        configuration.deploymentTarget.state === "resolved" &&
        supportsPrebuiltAuthDeploymentTarget(configuration.deploymentTarget.value),
    )
  );
}

const PRISTINE_CONTENT_VIEW = `import SwiftUI

struct ContentView: View {
  var body: some View {
    VStack {
      Image(systemName: "globe")
        .imageScale(.large)
        .foregroundStyle(.tint)
      Text("Hello, world!")
    }
    .padding()
  }
}

#Preview {
  ContentView()
}
`;

const SIMPLE_CONTENT_VIEW = `import SwiftUI

struct ContentView: View {
  var body: some View {
    Text("Hello, world!")
  }
}

#Preview {
  ContentView()
}
`;

const GENERATED_CONTENT_VIEW = `import SwiftUI
import ClerkKit
import ClerkKitUI

struct ContentView: View {
  @State private var authIsPresented = false

  var body: some View {
    VStack {
      UserButton(signedOutContent: {
        Button("Sign up") {
          authIsPresented = true
        }
      })
    }
    .prefetchClerkImages()
    .sheet(isPresented: $authIsPresented) {
      AuthView()
    }
  }
}
`;

const pristineForms = new Set(
  [PRISTINE_CONTENT_VIEW, SIMPLE_CONTENT_VIEW].map((source) => compactSwift(source)),
);
const generatedForm = compactSwift(GENERATED_CONTENT_VIEW);

function classifyContentView(source: string): {
  kind: "pristine" | "generated" | "other";
  header?: string;
} {
  const split = splitHeader(source);
  if (!split || split.body.includes("//") || split.body.includes("/*")) return { kind: "other" };
  const compact = compactSwift(split.body);
  if (compact != null && compact === generatedForm)
    return { kind: "generated", header: split.header };
  if (compact != null && pristineForms.has(compact))
    return { kind: "pristine", header: split.header };
  return { kind: "other" };
}

async function gitDirtyState(
  root: string,
  absolutePath: string,
): Promise<"clean" | "dirty" | "not-repository" | "unknown"> {
  try {
    const child = Bun.spawn(
      ["git", "status", "--porcelain=v1", "--untracked-files=all", "--", absolutePath],
      { cwd: root, stdout: "pipe", stderr: "ignore" },
    );
    const output = await new Response(child.stdout).text();
    const exitCode = await child.exited;
    if (exitCode === 0) return output.trim() === "" ? "clean" : "dirty";
    const probe = Bun.spawn(["git", "rev-parse", "--is-inside-work-tree"], {
      cwd: root,
      stdout: "ignore",
      stderr: "ignore",
    });
    return (await probe.exited) === 0 ? "unknown" : "not-repository";
  } catch {
    return "unknown";
  }
}

async function sourceIdentityOccurrences(
  memberships: Awaited<ReturnType<typeof inspectIOSSourceMembership>>,
  snapshot: SourceSnapshot,
): Promise<number | undefined> {
  let occurrences = 0;
  try {
    for (const membership of memberships) {
      if (!membership.complete) return undefined;
      for (const file of membership.files) {
        const info = await lstat(file.absolutePath);
        if (!info.isFile() || info.isSymbolicLink()) return undefined;
        if (info.dev === snapshot.device && info.ino === snapshot.inode) occurrences += 1;
      }
    }
    return occurrences;
  } catch {
    return undefined;
  }
}

async function preparePlan(options: IOSPrebuiltAuthPlanOptions): Promise<PreparedPlan> {
  const root = resolve(options.root);
  const absoluteProjectPath = resolve(root, options.projectPath);
  if (
    !options.targetId ||
    !options.projectPath ||
    resolve(root, relative(root, absoluteProjectPath)) !== absoluteProjectPath ||
    !(await pathIsSafelyWithinIOSRoot(root, absoluteProjectPath))
  ) {
    return blocked(
      options,
      root,
      options.projectPath,
      "invalid-selection",
      "The selected Xcode project or target is invalid.",
    );
  }
  const projectPath = relativeIOSPath(root, absoluteProjectPath);
  const inspection = await inspectIOSProject(root, { target: options.targetId });
  if (
    inspection.selection.state !== "selected" ||
    inspection.selection.targetId !== options.targetId ||
    inspection.selection.projectPath !== projectPath
  ) {
    return blocked(
      options,
      root,
      projectPath,
      "target-not-found",
      "The selected native iOS application target could not be proven.",
    );
  }
  const generator =
    inspection.generatedProject ?? (await generatedProjectKind(root, absoluteProjectPath));
  if (generator != null) {
    return blocked(
      options,
      root,
      projectPath,
      "generated-project",
      `This is a ${generator === "xcodegen" ? "XcodeGen" : "Tuist"} project; update its source manifest instead of generated Swift sources.`,
    );
  }
  const target = inspection.appTargets.find(
    (candidate) => candidate.id === options.targetId && candidate.projectPath === projectPath,
  );
  if (!target) {
    return blocked(
      options,
      root,
      projectPath,
      "target-not-found",
      "The selected native iOS application target disappeared during inspection.",
    );
  }
  if (!targetSupportsPrebuiltAuth(target.configurations)) {
    return blocked(
      options,
      root,
      projectPath,
      "incompatible-deployment-target",
      "ClerkKitUI's native components require iOS 17.0 or newer. Set IPHONEOS_DEPLOYMENT_TARGET to 17.0 or newer for every selected-target iPhone and iPad build configuration, make device and simulator values consistent, then rerun clerk init.",
    );
  }
  if (!target.swift.evidenceComplete) {
    return blocked(
      options,
      root,
      projectPath,
      "incomplete-source-membership",
      "The selected target's complete Swift source membership could not be proven.",
    );
  }
  if (target.swift.entryPoints.length !== 1 || !target.swift.entryPoints[0]?.path) {
    return blocked(
      options,
      root,
      projectPath,
      "ambiguous-entry-point",
      "The selected target must contain exactly one shipping @main Swift entry point.",
    );
  }
  const appSourcePath = target.swift.entryPoints[0].path;
  const appSnapshot = await sourceSnapshot(root, appSourcePath);
  if (!appSnapshot) {
    return blocked(
      options,
      root,
      projectPath,
      "unreadable-source",
      "The selected @main Swift source is not a safe, readable in-root regular file.",
      { appSourcePath },
    );
  }
  const appDetails = {
    appSourcePath,
    expectedAppSourceHash: appSnapshot.hash,
  };
  if (!hasExactIOSSwiftUIAppContentRoot(appSnapshot.source)) {
    return blocked(
      options,
      root,
      projectPath,
      "unsupported-app-structure",
      "The shipping WindowGroup must have one direct ContentView root before the optional prebuilt UI can be added.",
      appDetails,
    );
  }

  const memberships = await inspectIOSSourceMembership(root);
  const selectedMembership = memberships.find(
    (membership) =>
      membership.targetId === options.targetId && membership.projectPath === projectPath,
  );
  if (!selectedMembership?.complete || memberships.some((membership) => !membership.complete)) {
    return blocked(
      options,
      root,
      projectPath,
      "incomplete-source-membership",
      "Complete source ownership across every local native target could not be proven.",
      appDetails,
    );
  }
  const contentCandidates = selectedMembership.files.filter(
    (file) =>
      basename(file.absolutePath) === "ContentView.swift" &&
      dirname(file.absolutePath) === dirname(appSnapshot.absolutePath),
  );
  if (contentCandidates.length !== 1 || !contentCandidates[0]) {
    return blocked(
      options,
      root,
      projectPath,
      "missing-placeholder",
      "The selected target does not have one separate target-owned ContentView.swift beside its @main source.",
      appDetails,
    );
  }
  const sourcePath = contentCandidates[0].relativePath;
  const sourceSnapshotValue = await sourceSnapshot(root, sourcePath);
  if (!sourceSnapshotValue) {
    return blocked(
      options,
      root,
      projectPath,
      "unreadable-source",
      "ContentView.swift is not a safe, readable in-root regular UTF-8 source file.",
      { ...appDetails, sourcePath },
    );
  }
  const sourceDetails = {
    ...appDetails,
    sourcePath,
    expectedSourceHash: sourceSnapshotValue.hash,
  };
  const identityOccurrences = await sourceIdentityOccurrences(memberships, sourceSnapshotValue);
  if (identityOccurrences !== 1) {
    return blocked(
      options,
      root,
      projectPath,
      "shared-source",
      "ContentView.swift is shared, aliased, or not exclusively owned by the selected target.",
      sourceDetails,
    );
  }

  const classification = classifyContentView(sourceSnapshotValue.source);
  if (classification.kind === "generated") {
    return {
      appSnapshot,
      sourceSnapshot: sourceSnapshotValue,
      sourceHeader: classification.header,
      plan: makePlan(options, root, projectPath, "satisfied", {
        ...sourceDetails,
        actions: [
          `Verify ClerkKitUI's prebuilt UserButton and AuthView presentation in ${sourcePath}.`,
          "Verify Clerk images are prefetched for the prebuilt authentication UI.",
        ],
      }),
    };
  }
  if (classification.kind !== "pristine") {
    return blocked(
      options,
      root,
      projectPath,
      target.swift.authFlowReferences.length > 0 ||
        target.swift.openURLHandlers.length > 0 ||
        target.swift.importsClerkKitUI.length > 0
        ? "existing-authentication-flow"
        : "missing-placeholder",
      "Existing or customized application UI was preserved. Integrate AuthView manually in the app's signed-out route.",
      sourceDetails,
    );
  }
  if (
    target.swift.authFlowReferences.length > 0 ||
    target.swift.openURLHandlers.length > 0 ||
    target.swift.importsClerkKitUI.length > 0 ||
    target.swift.environmentConsumers.length > 0
  ) {
    return blocked(
      options,
      root,
      projectPath,
      "existing-authentication-flow",
      "Existing Clerk authentication source was preserved instead of layering a second prebuilt flow over it.",
      sourceDetails,
    );
  }
  if (!options.allowDirty) {
    const dirty = await gitDirtyState(root, sourceSnapshotValue.absolutePath);
    if (dirty === "dirty") {
      return blocked(
        options,
        root,
        projectPath,
        "dirty-source",
        `The planned Swift source ${sourcePath} has existing Git changes; pass the explicit dirty-file override to include it.`,
        sourceDetails,
      );
    }
    if (dirty === "unknown") {
      return blocked(
        options,
        root,
        projectPath,
        "git-state-unknown",
        `Git state for the planned Swift source ${sourcePath} could not be verified.`,
        sourceDetails,
      );
    }
  }
  return {
    appSnapshot,
    sourceSnapshot: sourceSnapshotValue,
    sourceHeader: classification.header,
    plan: makePlan(options, root, projectPath, "ready", {
      ...sourceDetails,
      actions: [
        `Replace only the untouched SwiftUI placeholder in ${sourcePath} with ClerkKitUI's documented UserButton and AuthView presentation.`,
        "Present AuthView from UserButton's signed-out content.",
        "Prefetch Clerk images for the prebuilt authentication UI.",
      ],
    }),
  };
}

export async function planIOSPrebuiltAuth(
  options: IOSPrebuiltAuthPlanOptions,
): Promise<IOSPrebuiltAuthPlan> {
  return (await preparePlan(options)).plan;
}

function mutationWithHiddenBytes(
  snapshot: SourceSnapshot,
  candidateBytes: Uint8Array,
): IOSPrebuiltAuthFileMutation {
  const mutation = {
    absolutePath: snapshot.absolutePath,
    expectedHash: snapshot.hash,
    candidateHash: hashIOSFileBytes(candidateBytes),
    mode: snapshot.mode,
  } as IOSPrebuiltAuthFileMutation;
  Object.defineProperties(mutation, {
    originalBytes: { value: snapshot.bytes, enumerable: false },
    candidateBytes: { value: candidateBytes, enumerable: false },
  });
  return mutation;
}

function readyPrepared(
  plan: IOSPrebuiltAuthPlan,
  mutation: IOSPrebuiltAuthFileMutation,
  validator: () => Promise<boolean>,
): PreparedIOSPrebuiltAuthMutation {
  const prepared = { status: "ready", plan } as PreparedIOSPrebuiltAuthMutation;
  Object.defineProperty(prepared, "mutation", { value: mutation, enumerable: false });
  preparedValidators.set(prepared, validator);
  return prepared;
}

export async function prepareIOSPrebuiltAuthMutation(
  plan: IOSPrebuiltAuthPlan,
): Promise<PreparedIOSPrebuiltAuthMutation> {
  if (plan.status === "blocked") return { status: "blocked", plan };
  if (
    plan.schemaVersion !== 1 ||
    plan.kind !== "clerk-ios-prebuilt-auth" ||
    !plan.appSourcePath ||
    !plan.expectedAppSourceHash ||
    !plan.sourcePath ||
    !plan.expectedSourceHash
  ) {
    return {
      status: "blocked",
      plan: {
        ...plan,
        status: "blocked",
        actions: [],
        blockers: [
          {
            code: "invalid-selection",
            message: "The prebuilt AuthView source plan is incomplete or unsupported.",
          },
        ],
      },
    };
  }
  const current = await preparePlan({
    root: plan.root,
    projectPath: plan.projectPath,
    targetId: plan.targetId,
    allowDirty: plan.allowDirty,
  });
  if (current.plan.status === "blocked" || !current.sourceSnapshot) {
    return { status: "blocked", plan: current.plan };
  }
  if (
    current.plan.appSourcePath !== plan.appSourcePath ||
    current.plan.sourcePath !== plan.sourcePath ||
    current.plan.expectedAppSourceHash !== plan.expectedAppSourceHash ||
    current.plan.expectedSourceHash !== plan.expectedSourceHash
  ) {
    return {
      status: "stale",
      plan,
      message: "The selected Swift sources changed after the preview.",
    };
  }
  if (current.plan.status === "satisfied") return { status: "satisfied", plan: current.plan };

  const newline = current.sourceSnapshot.newline;
  const generated = `${current.sourceHeader ?? ""}${GENERATED_CONTENT_VIEW.replace(/\n/g, newline)}`;
  const candidateBytes = new TextEncoder().encode(generated);
  const mutation = mutationWithHiddenBytes(current.sourceSnapshot, candidateBytes);
  const candidateHash = mutation.candidateHash;
  return readyPrepared(plan, mutation, async () => {
    const verified = await preparePlan({
      root: plan.root,
      projectPath: plan.projectPath,
      targetId: plan.targetId,
      allowDirty: true,
    });
    return (
      verified.plan.status === "satisfied" &&
      verified.plan.sourcePath === plan.sourcePath &&
      verified.plan.expectedSourceHash === candidateHash
    );
  });
}

export async function validatePreparedIOSPrebuiltAuth(
  prepared: PreparedIOSPrebuiltAuthMutation,
): Promise<boolean> {
  return (await preparedValidators.get(prepared)?.()) ?? false;
}

function asExistingMutation(mutation: IOSPrebuiltAuthFileMutation): IOSExistingFileMutation {
  return {
    path: mutation.absolutePath,
    originalBytes: mutation.originalBytes,
    originalHash: mutation.expectedHash,
    candidateBytes: mutation.candidateBytes,
    candidateHash: mutation.candidateHash,
    mode: mutation.mode,
  };
}

export async function applyIOSPrebuiltAuth(
  plan: IOSPrebuiltAuthPlan,
): Promise<IOSPrebuiltAuthApplyResult> {
  const prepared = await prepareIOSPrebuiltAuthMutation(plan);
  if (prepared.status !== "ready") return prepared;
  const result = await applyIOSFileTransaction(
    [asExistingMutation(prepared.mutation)],
    [async () => validatePreparedIOSPrebuiltAuth(prepared)],
  );
  if (result.status === "applied") return { status: "applied", plan };
  if (result.status === "stale") {
    return {
      status: "stale",
      plan,
      message: "The selected Swift source changed while the approved update was being committed.",
    };
  }
  return {
    status: "rolled-back",
    plan,
    message: "The AuthView source update failed validation and the original file was restored.",
  };
}
