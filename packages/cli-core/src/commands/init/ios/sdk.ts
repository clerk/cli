import {
  PBXFrameworksBuildPhase,
  PBXNativeTarget,
  XCRemoteSwiftPackageReference,
  XcodeProject,
} from "@bacons/xcode";
import { build, parse } from "@bacons/xcode/json";
import { isDeepStrictEqual } from "node:util";
import type { FileAction } from "../frameworks/types.ts";

import { CLERK_URL, isClerkRepository, scaffoldXCProjSDK } from "./xcproj-sdk.ts";
const PRODUCTS = ["ClerkKit", "ClerkKitUI"] as const;

export interface SDKInput {
  path: string;
  source: string;
  targetId: string;
  targetName: string;
  products: "core" | "ui";
  minimumVersion: string;
  managedBy: "xcode" | "xcodegen" | "tuist";
}

// The library adds defaults while loading. Copy only fields changed by our edit
// back into the parsed input, preserving unrelated objects and data literals.
function editedDocument(
  original: ReturnType<typeof parse>,
  before: ReturnType<XcodeProject["toJSON"]>,
  after: ReturnType<XcodeProject["toJSON"]>,
): string {
  if (!original.objects) throw new Error("Missing project objects");
  for (const [id, object] of Object.entries(after.objects)) {
    const previous = before.objects[id];
    if (!previous) {
      original.objects[id] = object;
      continue;
    }
    const destination = original.objects[id] as unknown as Record<string, unknown>;
    const oldFields = previous as unknown as Record<string, unknown>;
    const newFields = object as unknown as Record<string, unknown>;
    for (const key of new Set([...Object.keys(oldFields), ...Object.keys(newFields)])) {
      if (isDeepStrictEqual(oldFields[key], newFields[key])) continue;
      if (key in newFields) destination[key] = newFields[key];
      else delete destination[key];
    }
  }
  return build(original);
}

export function scaffoldSDK(input: SDKInput): FileAction {
  const skip = (skipReason: string): FileAction => ({ type: "skip", path: input.path, skipReason });
  if (input.managedBy !== "xcode")
    return skip(`Add Clerk in the ${input.managedBy} specification.`);
  if (!/^[1-9]\d*\.\d+\.\d+$/.test(input.minimumVersion)) {
    return skip("Choose a released Clerk SDK minimum version.");
  }
  if (input.path.endsWith("/project.xcproj")) return scaffoldXCProjSDK(input);
  if (!input.path.endsWith("/project.pbxproj"))
    return skip("Select a supported Xcode project document.");

  try {
    const original = parse(input.source);
    const project = new XcodeProject(input.path, original);
    const before = project.toJSON();
    const target = project.rootObject.props.targets.find((item) => item.uuid === input.targetId);
    if (
      !PBXNativeTarget.is(target) ||
      target.props.productType !== "com.apple.product-type.application" ||
      target.props.name !== input.targetName
    ) {
      return skip("Select the application target that matches the Xcode settings result.");
    }

    const phases = target.props.buildPhases.filter(PBXFrameworksBuildPhase.is);
    if (
      phases.length > 1 ||
      phases.some((phase) =>
        project.rootObject.props.targets.some(
          (other) =>
            other.uuid !== target.uuid &&
            other.props.buildPhases.some((item) => item.uuid === phase.uuid),
        ),
      )
    ) {
      return skip("The target has shared or multiple Frameworks phases; add Clerk in Xcode.");
    }

    const packages = (project.rootObject.props.packageReferences ?? [])
      .filter(XCRemoteSwiftPackageReference.is)
      .filter((item) => isClerkRepository(item.props.repositoryURL));
    if (packages.length > 1) return skip("Multiple Clerk package references need review in Xcode.");
    const existing = packages[0];
    const linked = target.getSwiftPackageProductDependencies();
    for (const name of PRODUCTS) {
      const products = linked.filter((item) => item.props.productName === name);
      if (
        products.length > 1 ||
        products.some((item) => !existing || item.props.package?.uuid !== existing.uuid)
      ) {
        return skip(
          "Existing Clerk products have ambiguous, local, or different package ownership; review in Xcode.",
        );
      }
      if (products[0]) {
        const buildFiles = phases
          .flatMap((phase) => phase.props.files)
          .filter((file) => file.props.productRef?.uuid === products[0]!.uuid);
        if (
          buildFiles.length !== 1 ||
          buildFiles[0]!.props.platformFilter ||
          buildFiles[0]!.props.platformFilters
        ) {
          return skip("Existing Clerk linkage is incomplete or conditional; review in Xcode.");
        }
      }
    }

    const requested = input.products === "ui" ? PRODUCTS : [PRODUCTS[0]];
    const missing = requested.filter(
      (name) => !linked.some((item) => item.props.productName === name),
    );
    if (missing.length === 0)
      return skip(
        "Requested Clerk products are already linked; package compatibility is not verified.",
      );
    const reference =
      existing ??
      project.rootObject.addRemoteSwiftPackage({
        repositoryURL: CLERK_URL,
        requirement: { kind: "upToNextMajorVersion", minimumVersion: input.minimumVersion },
      });
    for (const productName of missing)
      target.addSwiftPackageProduct({ productName, package: reference });
    return {
      type: "modify",
      path: input.path,
      content: editedDocument(original, before, project.toJSON()),
      description: `Link ${missing.join(" and ")} to ${input.targetName}; preserve existing package requirements`,
    };
  } catch {
    return skip("The project graph is unsupported for automatic setup; add Clerk in Xcode.");
  }
}
