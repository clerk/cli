import { doctor } from "../init/ios/doctor.ts";
import { CLERK_SWIFT_MINIMUM_VERSION, SWIFT_QUICKSTART } from "../init/ios/coordinator.ts";
import type { Dependencies, SetupOptions } from "../init/ios/workflow.ts";
import { interruptSignal } from "../../lib/signals.ts";
import type { CheckResult, DoctorContext } from "./types.ts";

export interface IOSDoctorOptions {
  root: string;
  target?: string;
  project?: string;
  configuration?: string;
}

export async function runIOSDoctorChecks(
  ctx: DoctorContext,
  options: IOSDoctorOptions,
  dependencies: Dependencies = {},
): Promise<{ results: CheckResult[] }> {
  const profile = await ctx.getProfile();
  const setup: SetupOptions = {
    ...options,
    products: "core",
    minimumVersion: CLERK_SWIFT_MINIMUM_VERSION,
    inspectOnly: true,
    signal: interruptSignal(),
    remote: profile ? { applicationId: profile.profile.appId } : undefined,
  };
  let report: Awaited<ReturnType<typeof doctor>>;
  let remoteUnavailable = false;
  try {
    report = await doctor(setup, dependencies);
  } catch (error) {
    setup.signal?.throwIfAborted();
    if (!setup.remote) throw error;
    // Preserve local diagnostics when account access or the remote service fails.
    report = await doctor({ ...setup, remote: undefined }, dependencies);
    remoteUnavailable = true;
  }
  const results: CheckResult[] = report.checks.map((check) => ({
    ...check,
    remedy:
      check.status === "pass"
        ? undefined
        : check.name === "App integration"
          ? `Finish source integration and verify your app: ${SWIFT_QUICKSTART}`
          : "Run clerk init to review and complete the remaining setup.",
  }));
  if (remoteUnavailable)
    results.push({
      name: "Clerk settings",
      status: "warn",
      message: "Remote settings could not be checked; local diagnostics are shown.",
      remedy: "Check your Clerk login and application access, then rerun clerk doctor.",
    });
  return { results };
}
