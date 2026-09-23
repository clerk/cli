import { test, expect, describe, beforeEach, mock } from "bun:test";
import { CliError, ERROR_CODE } from "../../lib/errors.ts";
import { setMode } from "../../mode.ts";
import { useCaptureLog } from "../../test/lib/stubs.ts";
import { CHECK_NAME, type CheckKey, type CheckResult } from "./types.ts";

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

// Replaced wholesale, so every export of checks.ts has to be here.
mock.module("./checks.ts", () => ({
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

  // Pinned rather than left to TTY detection, so the registry's agent-only
  // check is included by decision, not by whether the runner has a terminal.
  beforeEach(() => {
    outcomes = {};
    setMode("human");
  });

  async function jsonResults(): Promise<CheckResult[]> {
    try {
      await doctor({ json: true });
    } catch {
      // a failing check throws after the output is written; the output is what's read
    }
    return JSON.parse(captured.out) as CheckResult[];
  }

  test("an agent gets the host execution check first; a human does not get it", async () => {
    setMode("agent");
    const agentNames = (await jsonResults()).map((result) => result.name);
    expect(agentNames[0]).toBe(CHECK_NAME.hostExecution);
    expect(agentNames).toHaveLength(Object.keys(CHECK_NAME).length);

    captured.clear();
    setMode("human");
    const humanNames = (await jsonResults()).map((result) => result.name);
    expect(humanNames).not.toContain(CHECK_NAME.hostExecution);
    expect(humanNames).toEqual(agentNames.slice(1));
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
  });

  // An agent reading `--json` gets the same distinction the exit code carries:
  // `crashed` separates a broken CLI from a finding about the project, which
  // the `fail` status alone cannot.
  test("`--json` marks the crashed result and names it", async () => {
    outcomes.mcp = "throw";

    const results = await jsonResults();
    const crashed = results.filter((result) => result.crashed);
    expect(crashed).toHaveLength(1);
    expect(crashed[0]?.name).toBe(CHECK_NAME.mcp);
    expect(results.every((result) => result.name !== "Unknown check")).toBe(true);
  });
});
