import { doctor } from "../init/android/doctor.ts";
import { CLERK_ANDROID_MINIMUM_VERSION } from "../init/android/coordinator.ts";
import type { Dependencies } from "../init/android/workflow.ts";
import { errorMessage } from "../../lib/errors.ts";
import { interruptSignal } from "../../lib/signals.ts";
import type { CheckResult, DoctorContext, DoctorOptions } from "./types.ts";

const NAME = "Android project";

/** Read-only checks for a native Android app: Gradle module, manifest, initialization, registration. */
export async function runAndroidDoctorChecks(
  ctx: DoctorContext,
  options: Pick<DoctorOptions, "androidModule" | "androidPackage" | "androidFingerprint"> & {
    root?: string;
  },
  dependencies: Dependencies = {},
): Promise<CheckResult[]> {
  const signal = interruptSignal();
  const profile = await ctx.getProfile();
  const setup = {
    root: options.root ?? process.cwd(),
    module: options.androidModule,
    applicationId: options.androidPackage,
    fingerprints: options.androidFingerprint,
    sdk: "core" as const,
    minimumVersion: CLERK_ANDROID_MINIMUM_VERSION,
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
        message: `The Android project could not be inspected: ${errorMessage(error)}`,
        remedy:
          "Run from the project root, or pass --android-module (and --android-package when the applicationId isn't a plain literal).",
      },
    ];
  }
  const results: CheckResult[] = report.checks.map((check) => ({
    ...check,
    remedy:
      check.status === "pass"
        ? undefined
        : (check.remedy ?? "Run clerk init to complete the remaining setup."),
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
