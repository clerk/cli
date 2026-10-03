import { doctor } from "../init/ios/doctor.ts";
import { CLERK_SWIFT_MINIMUM_VERSION } from "../init/ios/coordinator.ts";
import type { Dependencies } from "../init/ios/workflow.ts";
import { errorMessage } from "../../lib/errors.ts";
import { interruptSignal } from "../../lib/signals.ts";
import type { CheckResult, DoctorContext, DoctorOptions } from "./types.ts";

const NAME = "Xcode project";

/** Read-only checks for a native Apple app: Xcode project, packages, capabilities, registration. */
export async function runIOSDoctorChecks(
  ctx: DoctorContext,
  options: Pick<DoctorOptions, "xcodeProject" | "xcodeTarget" | "xcodeConfiguration"> & {
    root?: string;
  },
  dependencies: Dependencies = {},
): Promise<CheckResult[]> {
  if (process.platform !== "darwin")
    return [
      {
        name: NAME,
        status: "warn",
        message: "Checking an Xcode project needs Xcode, which runs only on macOS.",
        remedy: "Run clerk doctor on a Mac with Xcode installed.",
      },
    ];
  const signal = interruptSignal();
  const profile = await ctx.getProfile();
  const setup = {
    root: options.root ?? process.cwd(),
    project: options.xcodeProject,
    target: options.xcodeTarget,
    configuration: options.xcodeConfiguration,
    products: "core" as const,
    minimumVersion: CLERK_SWIFT_MINIMUM_VERSION,
    inspectOnly: true,
    signal,
    remote: profile ? { applicationId: profile.profile.appId } : undefined,
  };
  let report: Awaited<ReturnType<typeof doctor>>;
  let remoteError: unknown;
  try {
    try {
      report = await doctor(setup, dependencies);
    } catch (error) {
      signal.throwIfAborted();
      if (!setup.remote) throw error;
      // Keep the local checks when Clerk can't be reached or the account lacks access.
      remoteError = error;
      report = await doctor({ ...setup, remote: undefined }, dependencies);
    }
  } catch (error) {
    signal.throwIfAborted();
    return [
      {
        name: NAME,
        status: "fail",
        message: `The Xcode project could not be inspected: ${errorMessage(error)}`,
        remedy:
          "Run from the folder with your .xcodeproj, or pass --xcode-project and --xcode-target.",
      },
    ];
  }
  const results: CheckResult[] = report.checks.map((check) => ({
    ...check,
    remedy: check.status === "pass" ? undefined : "Run clerk init to complete the remaining setup.",
  }));
  if (remoteError)
    results.push({
      name: "Clerk native settings",
      status: "warn",
      message: `Clerk settings could not be checked: ${errorMessage(remoteError)}`,
      remedy: "Check your Clerk login and application access, then rerun clerk doctor.",
    });
  return results;
}
