import { test, expect, describe, beforeEach, mock } from "bun:test";
import { CliError, ERROR_CODE } from "../../lib/errors.ts";
import { useCaptureLog } from "../../test/lib/stubs.ts";
import type { CheckResult } from "./types.ts";

const actualChecks = await import("./checks.ts");
const { CHECK_NAME } = actualChecks;

type CheckKey = keyof typeof CHECK_NAME;
type Outcome = "pass" | "fail" | "throw";

/** What each check does on the next `doctor()` run; anything unset passes. */
let outcomes: Partial<Record<CheckKey, Outcome>> = {};

function stubCheck(key: CheckKey) {
  return async (): Promise<CheckResult> => {
    const outcome = outcomes[key] ?? "pass";
    if (outcome === "throw") throw new Error("the check itself blew up");
    return {
      name: CHECK_NAME[key],
      status: outcome,
      message: `${CHECK_NAME[key]}: ${outcome}`,
    };
  };
}

// Replaced wholesale, so every export of checks.ts has to be here — the real
// module is spread back in for the non-check exports (CHECK_NAME above all,
// which check-mcp.ts also reads).
mock.module("./checks.ts", () => ({
  ...actualChecks,
  checkCliVersion: stubCheck("cliVersion"),
  checkHostExecution: stubCheck("hostExecution"),
  checkLoggedIn: stubCheck("loggedIn"),
  checkTokenValid: stubCheck("tokenValid"),
  checkProjectLinked: stubCheck("projectLinked"),
  checkLinkedAppExists: stubCheck("linkedAppExists"),
  checkInstances: stubCheck("instances"),
  checkEnvVars: stubCheck("envVars"),
  checkConfigFile: stubCheck("configFile"),
  checkShellCompletion: stubCheck("shellCompletion"),
}));

mock.module("./check-mcp.ts", () => ({ checkMcp: stubCheck("mcp") }));

const { doctor } = await import("./index.ts");

async function runDoctor(): Promise<CliError | undefined> {
  try {
    await doctor();
  } catch (error) {
    return error as CliError;
  }
  return undefined;
}

describe("doctor", () => {
  const captured = useCaptureLog();

  beforeEach(() => {
    outcomes = {};
  });

  test("a run where every check answered and passed succeeds", async () => {
    expect(await runDoctor()).toBeUndefined();
  });

  // The two failure codes are the point: one sends the reader to their own
  // project, the other to the CLI.
  test("a check that found a real problem reports doctor_failed", async () => {
    outcomes.envVars = "fail";

    const error = await runDoctor();

    expect(error?.code).toBe(ERROR_CODE.DOCTOR_FAILED);
    expect(error?.message).toContain("issues with your Clerk integration");
  });

  test("a check that threw reports doctor_check_crashed instead", async () => {
    outcomes.tokenValid = "throw";

    const error = await runDoctor();

    expect(error?.code).toBe(ERROR_CODE.DOCTOR_CHECK_CRASHED);
  });

  // A crash outranks a finding: the run can no longer claim to have checked
  // everything, so "your integration has issues" would be the wrong answer.
  test("a crash alongside a real finding still reports doctor_check_crashed", async () => {
    outcomes.envVars = "fail";
    outcomes.tokenValid = "throw";

    expect((await runDoctor())?.code).toBe(ERROR_CODE.DOCTOR_CHECK_CRASHED);
  });

  test("the crashed check is named on screen, with what it threw", async () => {
    outcomes.tokenValid = "throw";

    await runDoctor();

    expect(captured.err).toContain(
      `${CHECK_NAME.tokenValid} check crashed: the check itself blew up`,
    );
    expect(captured.err).not.toContain("Unknown check");
  });

  // An agent reading `--json` gets the same distinction the exit code carries:
  // `crashed` separates a broken CLI from a finding about the project, which
  // the `fail` status alone cannot.
  test("`--json` marks the crashed result and names it", async () => {
    outcomes.mcp = "throw";

    try {
      await doctor({ json: true });
    } catch {
      // the thrown failure is asserted above; this test reads the output
    }

    const results = JSON.parse(captured.out) as CheckResult[];
    const crashed = results.filter((result) => result.crashed);
    expect(crashed).toHaveLength(1);
    expect(crashed[0]?.name).toBe(CHECK_NAME.mcp);
    expect(results.every((result) => result.name !== "Unknown check")).toBe(true);
  });
});
