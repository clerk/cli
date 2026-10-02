import { build, parse } from "@bacons/xcode/json";
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
    return (root.configurations as (string | { name: string })[]).map((value) =>
      typeof value === "string" ? value : value.name,
    );
  }
  const objects = parse(source).objects as Record<string, any>;
  return objects[objects[targetId].buildConfigurationList].buildConfigurations.map(
    (id: string) => objects[id].name,
  );
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
    const settings = Object.fromEntries(
      Object.entries(target.buildSettings)
        .filter(([key]) => !key.includes("[config=") || key.includes(config))
        .map(([key, value]) => [key.replace(config, ""), value]),
    );
    const others = targets.filter((item) => item !== target);
    const inherits = (value: unknown) =>
      Array.isArray(value) &&
      value.some((item) => typeof item === "object" && item !== null && "file" in item);
    let candidate = source;
    return {
      settings,
      ownershipUnresolved:
        others.length > 0 &&
        (inherits(root.configurations) ||
          Object.keys((root["build-settings"] ?? {}) as object).some((key) =>
            key.startsWith("CODE_SIGN_ENTITLEMENTS"),
          ) ||
          others.some((other) => inherits(other.raw["specialized-configurations"]))),
      otherSettings: others.map((other) => other.buildSettings),
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
  const inherited = [
    ...configs(objects[graph.rootObject!]),
    ...others.flatMap(([, target]) => configs(target)),
  ];
  return {
    settings,
    ownershipUnresolved:
      others.length > 0 &&
      (inherited.some((config) => config.baseConfigurationReference) ||
        configs(objects[graph.rootObject!]).some((config) =>
          Object.keys(config.buildSettings ?? {}).some((key) =>
            key.startsWith("CODE_SIGN_ENTITLEMENTS"),
          ),
        ) ||
        others.some(([, target]) => configs(target).length === 0)),
    otherSettings: others.flatMap(([, target]) =>
      configs(target).map((config) => config.buildSettings ?? {}),
    ) as Record<string, unknown>[],
    set(key: string, value: string) {
      settings[key] = value;
    },
    serialize: () => build(graph),
  };
}
