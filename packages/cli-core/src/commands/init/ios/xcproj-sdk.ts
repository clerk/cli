import {
  applyXCProjValue,
  parseXCProjSource,
  resolveXCProjTargetBuildPhaseReference,
  xcprojPackages,
  xcprojTargets,
} from "./xcproj.ts";
import type { FileAction } from "../frameworks/types.ts";
import type { SDKInput } from "./sdk.ts";

export const CLERK_URL = "https://github.com/clerk/clerk-ios.git";
export function isClerkRepository(value: string | undefined): boolean {
  return (
    value
      ?.replace(/\.git\/?$/, "")
      .replace(/\/$/, "")
      .toLowerCase() === "https://github.com/clerk/clerk-ios"
  );
}

export function scaffoldXCProjSDK(input: SDKInput): FileAction {
  const skip = (skipReason: string): FileAction => ({ type: "skip", path: input.path, skipReason });
  try {
    const { root } = parseXCProjSource(input.source);
    const targets = xcprojTargets(root);
    const index = targets.findIndex((target) => target.id === input.targetId);
    const target = targets[index];
    if (
      !target ||
      target.name !== input.targetName ||
      targets.filter((item) => item.id === target.id).length !== 1 ||
      !["application", "com.apple.product-type.application"].includes(target.productType ?? "")
    )
      return skip("Select an unambiguous application target.");
    const packages = xcprojPackages(root);
    const identity = packages.filter(
      (item) =>
        (item.kind === "remote" ? item.repository : item.path)
          .replace(/\/$/, "")
          .split("/")
          .at(-1)
          ?.replace(/\.git$/, "")
          .toLowerCase() === "clerk-ios",
    );
    if (
      identity.length > 1 ||
      identity.some((item) => item.kind !== "remote" || !isClerkRepository(item.repository))
    )
      return skip("Existing Clerk package ownership needs review in Xcode.");
    const phases = target.buildPhases.filter((phase) => phase.kind === "frameworks");
    if (phases.length > 1) return skip("Multiple Frameworks phases need review in Xcode.");
    const products = ["ClerkKit", "ClerkKitUI"];
    for (const name of products) {
      const members = target.packageProductMembers.filter(
        (member) => member["product-name"] === name,
      );
      if (
        members.length > 1 ||
        members.some((member) => {
          const phase = member["build-phase"] as Record<string, unknown>;
          return (
            identity.length !== 1 ||
            member.package !== "clerk-ios" ||
            phase.platforms !== undefined ||
            resolveXCProjTargetBuildPhaseReference(target, phase["build-phase"])?.kind !==
              "frameworks"
          );
        })
      )
        return skip("Existing Clerk linkage is ambiguous or conditional; review in Xcode.");
    }
    const missing = (input.products === "ui" ? products : [products[0]!]).filter(
      (name) => !target.packageProductMembers.some((member) => member["product-name"] === name),
    );
    if (!missing.length)
      return skip(
        "Requested Clerk products are already linked; package compatibility is not verified.",
      );
    let source = input.source;
    if (!identity.length)
      source = applyXCProjValue(
        source,
        ["packages"],
        [
          ...packages.map((item) => item.raw),
          {
            kind: "remote",
            repository: CLERK_URL,
            version: { "up-to-next-major-version": input.minimumVersion },
          },
        ],
      );
    if (!phases.length)
      source = applyXCProjValue(
        source,
        ["targets", index, "build-phases"],
        [...target.buildPhases.map((phase) => phase.raw), "frameworks"],
      );
    source = applyXCProjValue(
      source,
      ["targets", index, "package-product-members"],
      [
        ...target.packageProductMembers,
        ...missing.map((name) => ({
          package: "clerk-ios",
          "product-name": name,
          "build-phase": { "build-phase": phases[0]?.id ? `id:${phases[0].id}` : "frameworks" },
        })),
      ],
    );
    return {
      type: "modify",
      path: input.path,
      content: source,
      description: `Link ${missing.join(" and ")} to ${input.targetName}; preserve existing package requirements`,
    };
  } catch {
    return skip("This .xcproj structure needs review in Xcode before adding Clerk.");
  }
}
