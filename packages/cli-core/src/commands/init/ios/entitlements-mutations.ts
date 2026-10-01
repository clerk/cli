import { dirname, isAbsolute, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { pathIsSafelyWithinIOSRoot } from "./discovery.ts";
import {
  hashIOSFileBytes,
  prepareIOSFileMutationBoundary,
  type IOSCreateFileMutation,
  type IOSExistingFileMutation,
  type IOSFileMutation,
} from "./file-transaction.ts";
import {
  prepareIOSMissingEntitlementsSettingsMutation,
  type IOSMissingEntitlementsSettingsPlan,
} from "./entitlements-settings.ts";
import { xcodeProjectDocumentPath } from "./project-document.ts";

interface EntitlementsPlanFile {
  path: string;
  operation: "create" | "modify";
  expectedHash?: string;
}

interface EntitlementsMutationPlan {
  root: string;
  projectPath: string;
  files: readonly EntitlementsPlanFile[];
  missingEntitlementsSettings?: IOSMissingEntitlementsSettingsPlan;
}

interface EntitlementsDocument {
  bytes: Uint8Array;
  hash: string;
  mode: number;
}

type Inspection<Document, Blocker> =
  | { status: "safe"; document: Document }
  | { status: "blocked"; blocker: Blocker };

type InvalidPreparation = {
  status: "invalid";
  reason: "creation" | "project" | "base-project" | "settings" | "destination" | "file";
};

function isCreateMutation(mutation: IOSFileMutation): mutation is IOSCreateFileMutation {
  return "kind" in mutation && mutation.kind === "create";
}

export async function entitlementsBaseMutations(
  root: string,
  mutations: readonly IOSFileMutation[] = [],
): Promise<Map<string, IOSFileMutation> | undefined> {
  const byPath = new Map<string, IOSFileMutation>();
  for (const mutation of mutations) {
    const path = resolve(mutation.path);
    if (
      !isAbsolute(mutation.path) ||
      path !== mutation.path ||
      byPath.has(path) ||
      !(await pathIsSafelyWithinIOSRoot(root, path)) ||
      !Number.isInteger(mutation.mode) ||
      mutation.mode < 0 ||
      mutation.mode > 0o7777 ||
      hashIOSFileBytes(mutation.candidateBytes) !== mutation.candidateHash ||
      (!isCreateMutation(mutation) &&
        hashIOSFileBytes(mutation.originalBytes) !== mutation.originalHash)
    )
      return undefined;
    byPath.set(path, mutation);
  }
  return byPath;
}

export function sameEntitlementsPlanFiles(
  left: readonly EntitlementsPlanFile[],
  right: readonly EntitlementsPlanFile[],
): boolean {
  return (
    left.length === right.length &&
    left.every(
      (file, index) =>
        file.path === right[index]?.path &&
        file.operation === right[index]?.operation &&
        file.expectedHash === right[index]?.expectedHash,
    )
  );
}

/** Keep candidate bytes out of serialized plans, output, and telemetry. */
export function withHiddenEntitlementsMutations<Result extends object>(
  result: Result,
  mutations: IOSFileMutation[],
): Result & { mutations: IOSFileMutation[] } {
  return Object.defineProperty(result, "mutations", {
    value: mutations,
    enumerable: false,
    configurable: false,
    writable: false,
  }) as Result & { mutations: IOSFileMutation[] };
}

export async function prepareEntitlementsCreation(
  root: string,
  path: string,
  settings: IOSMissingEntitlementsSettingsPlan,
  baseProject?: IOSExistingFileMutation,
) {
  const prepared = await prepareIOSMissingEntitlementsSettingsMutation(settings, baseProject);
  if (prepared.status === "stale") return { status: "stale" } as const;
  if (prepared.status !== "ready") return { status: "invalid", reason: "settings" } as const;
  const boundary = await prepareIOSFileMutationBoundary(root, path);
  const expectedParent = settings.expectedSynchronizedRootIdentity;
  if (
    !expectedParent ||
    !settings.synchronizedRootPath ||
    dirname(path) !== resolve(root, settings.synchronizedRootPath)
  ) {
    return { status: "invalid", reason: "destination" } as const;
  }
  if (
    !boundary ||
    boundary.parentIdentity.device !== expectedParent.device ||
    boundary.parentIdentity.inode !== expectedParent.inode
  )
    return { status: "stale" } as const;
  return { status: "ready", boundary, projectMutation: prepared.mutation } as const;
}

/** Shared file mechanics; callers retain capability validation and plan revalidation. */
export async function prepareEntitlementsFileMutations<
  Document extends EntitlementsDocument,
  Blocker extends { code: string; message: string },
>(
  plan: EntitlementsMutationPlan,
  baseByPath: ReadonlyMap<string, IOSFileMutation>,
  capability: {
    inspectFile: (root: string, path: string) => Promise<Inspection<Document, Blocker>>;
    inspectBytes: (
      root: string,
      path: string,
      bytes: Uint8Array,
      mode: number,
    ) => Inspection<Document, Blocker>;
    newBytes: () => Uint8Array;
    // No current document means this is a new file composed with an earlier candidate.
    edit: (
      source: Document,
      current: Document | undefined,
      path: string,
    ) => { bytes: Uint8Array } | { blocker: Blocker } | undefined;
  },
): Promise<
  | InvalidPreparation
  | { status: "stale" | "satisfied" }
  | { status: "blocked"; blocker: Blocker }
  | { status: "ready"; mutations: IOSFileMutation[]; consumedBaseMutationPaths: string[] }
> {
  const createFile = plan.files.find((file) => file.operation === "create");
  if (createFile) {
    const settings = plan.missingEntitlementsSettings;
    if (plan.files.length !== 1 || !settings || createFile.path !== settings.entitlementsPath) {
      return { status: "invalid", reason: "creation" };
    }
    const path = resolve(plan.root, createFile.path);
    const projectPath = await xcodeProjectDocumentPath(resolve(plan.root, plan.projectPath));
    if (!projectPath) return { status: "invalid", reason: "project" };
    const base = baseByPath.get(path);
    const baseProject = baseByPath.get(projectPath);
    if (base && !isCreateMutation(base)) return { status: "stale" };
    if (baseProject && isCreateMutation(baseProject))
      return { status: "invalid", reason: "base-project" };
    const creation = await prepareEntitlementsCreation(plan.root, path, settings, baseProject);
    if (creation.status !== "ready") return creation;
    let mutation: IOSCreateFileMutation;
    if (base) {
      if (!isDeepStrictEqual(base.boundary, creation.boundary)) return { status: "stale" };
      const source = capability.inspectBytes(plan.root, path, base.candidateBytes, base.mode);
      if (source.status === "blocked") return source;
      const edited = capability.edit(source.document, undefined, createFile.path);
      if (!edited) return { status: "stale" };
      if ("blocker" in edited) return { status: "blocked", blocker: edited.blocker };
      mutation = {
        ...base,
        candidateBytes: edited.bytes,
        candidateHash: hashIOSFileBytes(edited.bytes),
      };
    } else {
      const candidateBytes = capability.newBytes();
      mutation = {
        kind: "create",
        path,
        boundary: creation.boundary,
        candidateBytes,
        candidateHash: hashIOSFileBytes(candidateBytes),
        mode: 0o644,
      };
    }
    return {
      status: "ready",
      // Publish the new plist before the project begins referencing it.
      mutations: [mutation, creation.projectMutation],
      consumedBaseMutationPaths: [...(base ? [path] : []), ...(baseProject ? [projectPath] : [])],
    };
  }

  const mutations: IOSExistingFileMutation[] = [];
  const consumedBaseMutationPaths: string[] = [];
  for (const file of plan.files) {
    if (file.operation !== "modify" || !file.expectedHash)
      return { status: "invalid", reason: "file" };
    const path = resolve(plan.root, file.path);
    const current = await capability.inspectFile(plan.root, path);
    if (current.status === "blocked" || current.document.hash !== file.expectedHash)
      return { status: "stale" };
    const base = baseByPath.get(path);
    if (base && isCreateMutation(base)) return { status: "stale" };
    const boundary = await prepareIOSFileMutationBoundary(plan.root, path);
    if (!boundary || (base && !isDeepStrictEqual(base.boundary, boundary)))
      return { status: "stale" };
    if (
      base &&
      (base.originalHash !== file.expectedHash ||
        base.mode !== current.document.mode ||
        hashIOSFileBytes(base.originalBytes) !== current.document.hash)
    )
      return { status: "stale" };
    const source = base
      ? capability.inspectBytes(plan.root, path, base.candidateBytes, base.mode)
      : current;
    if (source.status === "blocked") return source;
    const edited = capability.edit(source.document, current.document, file.path);
    if (!edited) continue;
    if ("blocker" in edited) return { status: "blocked", blocker: edited.blocker };
    const candidateHash = hashIOSFileBytes(edited.bytes);
    if (candidateHash === current.document.hash && !base) continue;
    mutations.push({
      path,
      boundary: base?.boundary ?? boundary,
      originalBytes: base?.originalBytes ?? current.document.bytes,
      originalHash: base?.originalHash ?? current.document.hash,
      candidateBytes: edited.bytes,
      candidateHash,
      mode: base?.mode ?? current.document.mode,
    });
    if (base) consumedBaseMutationPaths.push(path);
  }
  return mutations.length === 0
    ? { status: "satisfied" }
    : { status: "ready", mutations, consumedBaseMutationPaths };
}
