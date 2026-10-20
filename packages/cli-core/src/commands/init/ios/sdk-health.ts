import { parse } from "@bacons/xcode/json";
import semver from "semver";
import { parseXCProjSource, xcprojPackages } from "./xcproj.ts";
import { isClerkRepository } from "./xcproj-sdk.ts";
import type { SetupInput } from "./plan.ts";
import { snapshotFile } from "./files.ts";

export interface Check {
  name: string;
  status: "pass" | "warn" | "fail";
  message: string;
}

/** The project resolver's lockfile can establish compatibility without raising its minimum. */
export async function resolvedSDKHealth(input: SetupInput): Promise<Check | undefined> {
  try {
    const file = await snapshotFile(
      input.selection.root,
      `${input.selection.project}/project.xcworkspace/xcshareddata/swiftpm/Package.resolved`,
    );
    const lock = JSON.parse(file.source);
    const pins = (lock.pins ?? lock.object?.pins) as Record<string, any>[];
    if (!Array.isArray(pins)) return undefined;
    const clerk = pins.filter((pin) => isClerkRepository(pin.location ?? pin.repositoryURL));
    if (clerk.length !== 1) return undefined;
    const version = clerk[0]?.state?.version;
    if (typeof version !== "string" || !semver.valid(version)) return undefined;
    const compatible = semver.gte(version, input.minimumVersion);
    return {
      name: "SDK version requirement",
      status: compatible ? "pass" : "fail",
      message: compatible
        ? `Xcode resolved Clerk ${version}; it meets the ${input.minimumVersion} baseline. Compilation remains unverified.`
        : `Xcode resolved Clerk ${version}, below the ${input.minimumVersion} baseline. Update the package in Xcode.`,
    };
  } catch {
    return undefined;
  }
}
export function sdkHealth(input: SetupInput): Check {
  const check = (status: Check["status"], message: string): Check => ({
    name: "SDK version requirement",
    status,
    message,
  });
  try {
    let exact: unknown, minimum: unknown, maximum: unknown;
    if (input.projectFormat === "xcproj") {
      const packages = xcprojPackages(parseXCProjSource(input.projectSource).root).filter(
        (item) => item.kind === "remote" && isClerkRepository(item.repository),
      );
      if (packages.length !== 1 || packages[0]?.kind !== "remote")
        return check(
          "warn",
          "No unique remote Clerk requirement to inspect; local packages require manual version review.",
        );
      const version = packages[0].version ?? {};
      exact = version.version;
      minimum =
        version["up-to-next-major-version"] ??
        version["up-to-next-minor-version"] ??
        version["version-range-min"];
      maximum = version["version-range-max"];
      if (typeof version["version-range"] === "string")
        [minimum, maximum] = version["version-range"].split("..<");
      if (typeof minimum === "string" && semver.valid(minimum)) {
        if (version["up-to-next-major-version"]) maximum = `${semver.major(minimum) + 1}.0.0`;
        if (version["up-to-next-minor-version"])
          maximum = `${semver.major(minimum)}.${semver.minor(minimum) + 1}.0`;
      }
    } else {
      const objects = parse(input.projectSource).objects as Record<string, any>;
      const packages = Object.values(objects).filter(
        (item) =>
          item.isa === "XCRemoteSwiftPackageReference" && isClerkRepository(item.repositoryURL),
      );
      if (packages.length !== 1)
        return check(
          "warn",
          "No unique remote Clerk requirement to inspect; local packages require manual version review.",
        );
      const version = packages[0].requirement ?? {};
      if (version.kind === "exactVersion") exact = version.version;
      if (["upToNextMajorVersion", "upToNextMinorVersion", "versionRange"].includes(version.kind)) {
        minimum = version.minimumVersion;
        maximum = version.maximumVersion;
        if (typeof minimum === "string" && semver.valid(minimum)) {
          if (version.kind === "upToNextMajorVersion") maximum = `${semver.major(minimum) + 1}.0.0`;
          if (version.kind === "upToNextMinorVersion")
            maximum = `${semver.major(minimum)}.${semver.minor(minimum) + 1}.0`;
        }
      }
    }
    const required = input.minimumVersion;
    if (typeof exact === "string" && semver.valid(exact))
      return semver.gte(exact, required)
        ? check(
            "pass",
            `Exact requirement ${exact} meets the requested ${required} baseline; package resolution and compilation remain unverified.`,
          )
        : check(
            "fail",
            `Clerk is pinned to ${exact}, below the requested ${required} baseline. Review the pin in Xcode.`,
          );
    if (
      typeof minimum !== "string" ||
      !semver.valid(minimum) ||
      typeof maximum !== "string" ||
      !semver.valid(maximum)
    )
      return check(
        "warn",
        "Branch, revision, or unknown requirement: inspect the resolved Clerk SDK version in Xcode.",
      );
    if (semver.lte(maximum, minimum) || semver.lte(maximum, required))
      return check(
        "fail",
        `The Clerk requirement ${minimum}..<${maximum} cannot satisfy the requested ${required} baseline.`,
      );
    return semver.gte(minimum, required)
      ? check(
          "pass",
          `The requirement starts at ${minimum}, meeting the requested ${required} baseline; the resolved SDK and compilation remain unverified.`,
        )
      : check(
          "warn",
          `The requirement permits versions below ${required}. Check Package.resolved or update the minimum in Xcode.`,
        );
  } catch {
    return check("warn", "The Clerk version requirement could not be inspected.");
  }
}
