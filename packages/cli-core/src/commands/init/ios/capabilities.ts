import { DOMParser, XMLSerializer } from "@xmldom/xmldom";
import { capabilitySettings } from "./project.ts";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { lstat, realpath } from "node:fs/promises";
import type { FileAction } from "../frameworks/types.ts";
import { snapshotFile, type FileSnapshot } from "./files.ts";
import type { Inspection } from "./xcode.ts";
import { otherTargetSettings } from "./plan.ts";

const DOMAIN = "com.apple.developer.associated-domains";
const APPLE = "com.apple.developer.applesignin";
const SANDBOX = "com.apple.security.app-sandbox";
const NETWORK = "com.apple.security.network.client";
const EMPTY =
  '<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0">\n<dict/>\n</plist>\n';
type Element = ReturnType<DOMParser["parseFromString"]>["documentElement"];

// Appends before the container's closing tag, in Xcode's tab-indented layout
// unless the file is written compactly.
function insert(container: Element, node: Element, depth: number, pretty: boolean): void {
  if (!pretty) {
    container.appendChild(node);
    return;
  }
  const document = container.ownerDocument;
  const last = container.lastChild;
  if (!(last?.nodeType === 3 && !last.textContent?.trim()))
    container.appendChild(document.createTextNode(`\n${"\t".repeat(depth - 1)}`));
  const closing = container.lastChild!;
  container.insertBefore(document.createTextNode(`\n${"\t".repeat(depth)}`), closing);
  container.insertBefore(node, closing);
}
function elements(node: Element): Element[] {
  if (
    ["plist", "dict", "array"].includes(node.tagName) &&
    Array.from(node.childNodes).some(
      (child) => [3, 4].includes(child.nodeType) && child.textContent?.trim(),
    )
  )
    throw new Error("Unexpected text in an entitlement container.");
  return Array.from(node.childNodes).filter((child) => child.nodeType === 1) as Element[];
}

// Modify requested capabilities and macOS sandbox networking; retain unrelated XML nodes.
export function capabilityXML(source: string, domain?: string, apple = false, mac = false): string {
  if (source.length > 1_000_000 || /<!ENTITY/i.test(source))
    throw new Error("Unsupported entitlements XML.");
  const document = new DOMParser({
    errorHandler: () => {
      throw new Error("Invalid entitlements XML.");
    },
  }).parseFromString(source, "text/xml");
  const roots = elements(document.documentElement);
  if (
    document.documentElement.tagName !== "plist" ||
    roots.length !== 1 ||
    roots[0]!.tagName !== "dict"
  )
    throw new Error("Entitlements must contain one dictionary.");
  const dictionary = roots[0]!;
  const children = elements(dictionary);
  const pretty = !children.length || /\n\s*<key>/.test(source);
  const values = new Map<string, Element>();
  if (children.length % 2) throw new Error("Malformed entitlements dictionary.");
  for (let i = 0; i < children.length; i += 2) {
    const key = children[i]!;
    if (key.tagName !== "key" || elements(key).length || values.has(key.textContent ?? ""))
      throw new Error("Duplicate or malformed entitlement key.");
    values.set(key.textContent ?? "", children[i + 1]!);
  }
  let changed = false;
  if (mac) {
    for (const key of [SANDBOX, NETWORK]) {
      const value = values.get(key);
      if (
        value &&
        (!["true", "false"].includes(value.tagName) ||
          elements(value).length ||
          value.textContent?.trim())
      )
        throw new Error("Review the existing sandbox entitlement value manually.");
    }
    const network = values.get(NETWORK);
    if (values.get(SANDBOX)?.tagName === "true" && network?.tagName !== "true") {
      const enabled = document.createElement("true");
      if (network) dictionary.replaceChild(enabled, network);
      else {
        const name = document.createElement("key");
        name.appendChild(document.createTextNode(NETWORK));
        insert(dictionary, name, 1, pretty);
        insert(dictionary, enabled, 1, pretty);
      }
      changed = true;
    }
  }
  for (const [key, value] of [
    [DOMAIN, domain],
    [APPLE, apple ? "Default" : undefined],
  ] as const) {
    if (!value) continue;
    let array = values.get(key);
    if (array) {
      const strings = elements(array);
      if (
        array.tagName !== "array" ||
        strings.some((item) => item.tagName !== "string" || elements(item).length)
      )
        throw new Error("Review the existing entitlement value manually.");
      if (key === APPLE && strings.some((item) => item.textContent !== "Default"))
        throw new Error("Review the existing Apple entitlement policy.");
      if (strings.some((item) => item.textContent === value)) continue;
    } else {
      const name = document.createElement("key");
      name.appendChild(document.createTextNode(key));
      insert(dictionary, name, 1, pretty);
      array = document.createElement("array");
      insert(dictionary, array, 1, pretty);
    }
    const string = document.createElement("string");
    string.appendChild(document.createTextNode(value));
    insert(array, string, 2, pretty);
    changed = true;
  }
  if (!changed) return source;
  // The serializer drops the trailing newline; keep the file's own ending.
  return (
    new XMLSerializer().serializeToString(document).trimEnd() +
    source.slice(source.trimEnd().length)
  );
}

interface CapabilityPlan {
  status: "planned" | "satisfied" | "manual";
  scope: string;
  reason?: string;
  projectSource: string;
  actions: FileAction[];
  snapshots: FileSnapshot[];
  appleEntitlement: boolean;
}

async function planCapabilities(
  inspection: Inspection,
  projectSource: string,
  frontendHost?: string,
  apple = false,
  overlay: Map<string, FileAction> = new Map(),
): Promise<CapabilityPlan> {
  const { selection, managedBy, projectFormat } = inspection.input;
  const scope = `${selection.targetName}, ${selection.configuration}, ${selection.sdk}; an existing entitlement file also affects every context that uses that file`;
  const manual = (reason: string): CapabilityPlan => ({
    status: "manual",
    scope,
    reason,
    projectSource,
    actions: [],
    snapshots: [],
    appleEntitlement: false,
  });
  if (managedBy !== "xcode")
    return manual("Configure capabilities in the generator specification or Xcode.");
  try {
    const adapter = capabilitySettings(projectSource, projectFormat, selection);
    const { settings } = adapter;
    const sourceRoot =
      inspection.settings.SRCROOT ?? resolve(selection.root, dirname(selection.project));
    const mac = selection.sdk === "macosx";
    const domain = !mac && frontendHost ? `webcredentials:${frontendHost}` : undefined;
    if (!mac && !frontendHost)
      return manual("Link the intended Clerk instance before adding its Associated Domain.");
    let changedProject = false;
    // Xcode's native setting adds the outgoing-network entitlement during signing.
    if (
      mac &&
      inspection.settings.ENABLE_APP_SANDBOX === "YES" &&
      inspection.settings.ENABLE_OUTGOING_NETWORK_CONNECTIONS !== "YES"
    ) {
      const key = "ENABLE_OUTGOING_NETWORK_CONNECTIONS[sdk=macosx*]";
      if (
        Object.keys(settings).some(
          (name) => name.startsWith("ENABLE_OUTGOING_NETWORK_CONNECTIONS[") && name !== key,
        )
      )
        return manual("Review conditional network-access settings in Xcode.");
      if (settings[key] !== "YES") {
        adapter.set(key, "YES");
        changedProject = true;
      }
    }
    const actions: FileAction[] = [];
    const snapshots: FileSnapshot[] = [];
    let path = inspection.settings.CODE_SIGN_ENTITLEMENTS?.trim();
    if (domain || apple || (mac && path)) {
      let snapshot: FileSnapshot | undefined;
      if (path) {
        if (path.includes("$") || !path.endsWith(".entitlements"))
          return manual("Select a resolved .entitlements path in Xcode.");
        path = relative(selection.root, resolve(sourceRoot, path));
        if (isAbsolute(path) || path.split(/[\\/]/).includes(".."))
          return manual("The entitlement file is outside this project root.");
        // Xcode's resolved settings show whether another target uses this file,
        // whether it's set directly, through an xcconfig, or at the project level.
        // Check every inspected configuration: another target may use it only in Release.
        for (const other of inspection.contexts.flatMap((context) =>
          otherTargetSettings(selection, context.settingsJSON),
        )) {
          const value = other.CODE_SIGN_ENTITLEMENTS?.trim();
          if (!value) continue;
          const resolved = resolve(other.SRCROOT ?? sourceRoot, value);
          if ((await realpath(resolved).catch(() => resolved)) === resolve(selection.root, path))
            return manual("The entitlement file is shared with another target.");
        }
        // Explicit settings in configurations Xcode wasn't asked about.
        for (const other of adapter.otherSettings) {
          for (const [key, value] of Object.entries(other)) {
            if (!key.startsWith("CODE_SIGN_ENTITLEMENTS") || value === "") continue;
            if (
              typeof value !== "string" ||
              value.includes("$") ||
              (await realpath(resolve(sourceRoot, value))) === resolve(selection.root, path)
            )
              return manual("The entitlement file may be shared with another target.");
          }
        }
        snapshot = await snapshotFile(selection.root, path);
        snapshots.push(snapshot);
      } else {
        if (!/^[a-zA-Z0-9_-]+$/.test(selection.targetId))
          return manual(
            "Choose an ordinary project target identifier before creating entitlements.",
          );
        if (Object.keys(settings).some((key) => key.startsWith("CODE_SIGN_ENTITLEMENTS[")))
          return manual("Conditional entitlement routes require setup in Xcode.");
        const name = selection.targetName.replace(/[^a-zA-Z0-9_-]/g, "_") || selection.targetId;
        const filename = `${name}${mac ? "-macOS" : ""}.entitlements`;
        path = relative(selection.root, resolve(sourceRoot, filename));
        if (
          adapter.otherSettings.some((other) =>
            Object.entries(other).some(
              ([key, value]) =>
                key.startsWith("CODE_SIGN_ENTITLEMENTS") &&
                typeof value === "string" &&
                resolve(sourceRoot, value) === resolve(sourceRoot, filename),
            ),
          )
        )
          return manual("The proposed entitlement file is already referenced by another target.");
        try {
          await lstat(resolve(selection.root, path));
          return manual(
            "The proposed new entitlement file already exists; attach or review it in Xcode.",
          );
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
        adapter.set(`CODE_SIGN_ENTITLEMENTS[sdk=${mac ? "macosx*" : "iphone*"}]`, filename);
        changedProject = true;
      }
      const previous = overlay.get(path);
      const source =
        previous && previous.type !== "skip" ? previous.content : (snapshot?.source ?? EMPTY);
      const content = capabilityXML(source, domain, apple, mac);
      if (!snapshot || content !== source)
        actions.push({
          type: snapshot ? "modify" : "create",
          path,
          content,
          description: mac
            ? "Update macOS entitlements"
            : `Add ${[domain && "Clerk Associated Domain", apple && "Sign in with Apple"].filter(Boolean).join(" and ")}`,
        });
    }
    return {
      status: actions.length || changedProject ? "planned" : "satisfied",
      scope,
      projectSource: changedProject ? adapter.serialize() : projectSource,
      actions,
      snapshots,
      appleEntitlement: apple,
    };
  } catch {
    return manual(
      "The entitlement file or project cannot be edited with this recipe; configure capabilities in Xcode.",
    );
  }
}

// One project edit and one write per entitlement file, even when configurations share it.
export async function planAllCapabilities(
  inspection: Inspection,
  projectSource: string,
  frontendHost?: string,
  apple = false,
) {
  const actions = new Map<string, FileAction>();
  const snapshots = new Map<string, FileSnapshot>();
  const contexts: (Pick<CapabilityPlan, "status" | "scope" | "reason"> & {
    configuration: string;
  })[] = [];
  let source = projectSource;
  for (const context of inspection.contexts) {
    const plan = await planCapabilities(
      {
        ...inspection,
        settings: context.settings,
        input: {
          ...inspection.input,
          selection: context.selection,
          settingsJSON: context.settingsJSON,
        },
      },
      source,
      frontendHost,
      apple,
      actions,
    );
    source = plan.projectSource;
    for (const action of plan.actions) actions.set(action.path, action);
    for (const snapshot of plan.snapshots) snapshots.set(snapshot.path, snapshot);
    contexts.push({
      status: plan.status,
      scope: plan.scope,
      reason: plan.reason,
      configuration: context.selection.configuration,
    });
  }
  const manual = contexts.filter((context) => context.status === "manual");
  return {
    status: manual.length
      ? ("manual" as const)
      : contexts.some((context) => context.status === "planned")
        ? ("planned" as const)
        : ("satisfied" as const),
    scope: contexts.map((context) => context.scope).join("; "),
    reason: manual.length
      ? manual.map((context) => `${context.scope}: ${context.reason}`).join("; ")
      : undefined,
    projectSource: source,
    actions: [...actions.values()],
    snapshots: [...snapshots.values()],
    appleEntitlement: apple && !manual.length,
    contexts,
  };
}
