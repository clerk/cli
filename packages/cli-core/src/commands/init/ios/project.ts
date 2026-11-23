import { build, parse } from "@bacons/xcode/json";
import { posix } from "node:path";
import { pbxprojLocations } from "./target-sources.ts";
import { applyXCProjValue, parseXCProjSource, xcprojTargets } from "./xcproj.ts";
import type { Selection, SetupInput } from "./plan.ts";

// Format access only. Xcode, not this adapter, evaluates inherited build settings.
export function configurationNames(
  source: string,
  format: SetupInput["projectFormat"],
  targetId: string,
): string[] {
  if (format === "xcproj") {
    const { root } = parseXCProjSource(source);
    return ((root.configurations ?? []) as (string | { name: string })[]).map((value) =>
      typeof value === "string" ? value : value.name,
    );
  }
  const objects = parse(source).objects as Record<string, any>;
  return objects[objects[targetId].buildConfigurationList].buildConfigurations.map(
    (id: string) => objects[id].name,
  );
}

/**
 * The folders, relative to SRCROOT, whose files Xcode adds to the target on its own: a `.pbxproj`
 * target's synchronized root groups and a `.xcproj` target's member folders, in project order.
 * A folder placed outside the project's ordinary relative paths is left out.
 */
function pbxprojSynchronizedFolders(objects: Record<string, any>, targetId: string): string[] {
  const location = pbxprojLocations(objects, "");
  return ((objects[targetId]?.fileSystemSynchronizedGroups ?? []) as string[])
    .filter((id) => objects[id]?.isa === "PBXFileSystemSynchronizedRootGroup")
    .map((id) => location(id))
    .filter((path): path is string => path !== undefined && !posix.isAbsolute(path));
}

function xcprojMemberFolders(entries: unknown, targetName: string, base = ""): string[] {
  if (!Array.isArray(entries)) return [];
  return (entries as Record<string, unknown>[]).flatMap((entry) => {
    const path = typeof entry.path === "string" ? entry.path : "";
    if (posix.isAbsolute(path)) return [];
    const location = posix.join(base, path);
    if (entry.kind === "group") return xcprojMemberFolders(entry.children, targetName, location);
    const members = entry["target-membership"];
    return entry.kind === "folder" && Array.isArray(members) && members.includes(targetName)
      ? [location]
      : [];
  });
}

export function capabilitySettings(
  source: string,
  format: SetupInput["projectFormat"],
  selection: Selection,
) {
  if (!/^[\w -]+$/.test(selection.configuration))
    throw new Error("Review this configuration name in Xcode.");
  if (format === "xcproj") {
    const { root } = parseXCProjSource(source);
    const targets = xcprojTargets(root);
    const index = targets.findIndex((target) => target.id === selection.targetId);
    const target = targets[index];
    if (!target || targets.filter((item) => item.id === target.id).length !== 1)
      throw new Error("Ambiguous target.");
    const config = `[config=${selection.configuration}]`;
    // Unconditional values first, so a [config=X] value wins whatever the key order.
    const entries = Object.entries(target.buildSettings);
    const settings = Object.fromEntries([
      ...entries.filter(([key]) => !key.includes("[config=")),
      ...entries
        .filter(([key]) => key.includes(config))
        .map(([key, value]) => [key.replace(config, ""), value]),
    ]);
    const others = targets.filter((item) => item !== target);
    let candidate = source;
    return {
      settings,
      otherSettings: others.map((other) => other.buildSettings),
      synchronizedFolders: xcprojMemberFolders(root.files, target.name),
      set(key: string, value: string) {
        const bracket = key.indexOf("[");
        const name =
          bracket < 0 ? key + config : key.slice(0, bracket) + config + key.slice(bracket);
        candidate = applyXCProjValue(candidate, ["targets", index, "build-settings", name], value);
      },
      serialize: () => candidate,
    };
  }
  const graph = parse(source);
  const objects = graph.objects as Record<string, any>;
  const configs = (target: any): any[] =>
    (objects[target.buildConfigurationList]?.buildConfigurations ?? []).map((id: string) => ({
      id,
      ...objects[id],
    }));
  const matches = configs(objects[selection.targetId]).filter(
    (config) => config.name === selection.configuration,
  );
  if (matches.length !== 1) throw new Error("Ambiguous configuration.");
  const configuration = matches[0];
  const others = Object.entries(objects).filter(
    ([id, target]) => id !== selection.targetId && target.isa === "PBXNativeTarget",
  );
  if (others.some(([, other]) => configs(other).some((config) => config.id === configuration.id)))
    throw new Error("Shared configuration.");
  const settings = objects[configuration.id].buildSettings as Record<string, unknown>;
  if (!settings || Array.isArray(settings)) throw new Error("Unsupported settings.");
  return {
    settings,
    otherSettings: others.flatMap(([, target]) =>
      configs(target).map((config) => config.buildSettings ?? {}),
    ) as Record<string, unknown>[],
    synchronizedFolders: pbxprojSynchronizedFolders(objects, selection.targetId),
    set(key: string, value: string) {
      settings[key] = value;
    },
    serialize: () => build(graph),
  };
}
