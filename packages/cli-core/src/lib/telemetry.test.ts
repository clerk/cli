import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEV_CLI_VERSION } from "./version.ts";
import { _setConfigDir } from "./config.ts";
import {
  finalizeAndSendTelemetry,
  startCommandTelemetry,
  telemetryEnabled,
  telemetryResultForError,
  type TelemetryCommand,
} from "./telemetry.ts";
import { ApiError, CliError, EXIT_CODE, UserAbortError } from "./errors.ts";

// Isolate config I/O (machine uuid, notice flag) from the real user config dir.
let configDir: string;
beforeEach(async () => {
  configDir = await mkdtemp(join(tmpdir(), "clerk-telemetry-test-"));
  _setConfigDir(configDir);
});
afterEach(async () => {
  _setConfigDir(undefined);
  await rm(configDir, { recursive: true, force: true });
});

describe("telemetryEnabled", () => {
  const REAL = "1.2.3";

  test("enabled for release builds by default", () => {
    expect(telemetryEnabled({}, REAL)).toBe(true);
  });

  // Any non-empty value except an explicit "0"/"false" opts out — a user who
  // sets CLERK_TELEMETRY_DISABLED=yes meant to disable; silently staying on is
  // the worst failure mode for a privacy control.
  test.each([
    [{ CLERK_TELEMETRY_DISABLED: "1" }],
    [{ CLERK_TELEMETRY_DISABLED: "true" }],
    [{ CLERK_TELEMETRY_DISABLED: "yes" }],
    [{ CLERK_TELEMETRY_DISABLED: "anything" }],
    [{ DO_NOT_TRACK: "1" }],
    [{ DO_NOT_TRACK: "TRUE" }],
    [{ DO_NOT_TRACK: "on" }],
  ])("opt-out env %o disables", (env) => {
    expect(telemetryEnabled(env, REAL)).toBe(false);
  });

  test.each([
    [{ CLERK_TELEMETRY_DISABLED: "0" }],
    [{ CLERK_TELEMETRY_DISABLED: "false" }],
    [{ CLERK_TELEMETRY_DISABLED: "FALSE" }],
    [{ CLERK_TELEMETRY_DISABLED: "" }],
    [{ DO_NOT_TRACK: "0" }],
    [{ DO_NOT_TRACK: "false" }],
  ])("explicit-false env %o stays enabled", (env) => {
    expect(telemetryEnabled(env, REAL)).toBe(true);
  });

  test("dev builds are disabled unless CLERK_TELEMETRY_URL is set", () => {
    expect(telemetryEnabled({}, DEV_CLI_VERSION)).toBe(false);
    expect(telemetryEnabled({ CLERK_TELEMETRY_URL: "http://localhost:9" }, DEV_CLI_VERSION)).toBe(
      true,
    );
  });

  test("opt-out beats the URL escape hatch", () => {
    expect(
      telemetryEnabled({ CLERK_TELEMETRY_URL: "http://localhost:9", DO_NOT_TRACK: "1" }, REAL),
    ).toBe(false);
  });
});

describe("telemetryResultForError", () => {
  test("maps user aborts", () => {
    expect(telemetryResultForError(new UserAbortError())).toEqual({
      outcome: "abort",
      exitCode: EXIT_CODE.SUCCESS,
    });
  });

  test("maps CliError with code and exit code", () => {
    const error = new CliError("nope", { code: "not_linked" });
    expect(telemetryResultForError(error)).toEqual({
      outcome: "error",
      exitCode: error.exitCode,
      errorCode: "not_linked",
    });
  });

  test("maps CliError without code", () => {
    expect(telemetryResultForError(new CliError("nope")).errorCode).toBe("cli_error");
  });

  test("maps ApiError (code is null for a non-JSON body → api_error fallback)", () => {
    const error = new ApiError(500, "boom");
    expect(telemetryResultForError(error)).toEqual({
      outcome: "error",
      exitCode: EXIT_CODE.GENERAL,
      errorCode: "api_error",
    });
  });

  test("maps unknown errors", () => {
    expect(telemetryResultForError(new Error("x"))).toEqual({
      outcome: "error",
      exitCode: EXIT_CODE.GENERAL,
      errorCode: "unexpected_error",
    });
  });
});

describe("finalizeAndSendTelemetry", () => {
  const originalFetch = globalThis.fetch;

  // Isolate from ambient env: clear before each test too (not just after) so a
  // pre-set CLERK_TELEMETRY_DISABLED/DO_NOT_TRACK/CLERK_TELEMETRY_URL in the
  // shell can't change whether telemetry is enabled for the first test.
  beforeEach(() => {
    delete process.env.CLERK_TELEMETRY_URL;
    delete process.env.CLERK_TELEMETRY_DISABLED;
    delete process.env.DO_NOT_TRACK;
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
    delete process.env.CLERK_TELEMETRY_URL;
    delete process.env.CLERK_TELEMETRY_DISABLED;
    delete process.env.DO_NOT_TRACK;
  });

  function fakeCommand(): TelemetryCommand {
    return { name: () => "list", options: [], getOptionValueSource: () => undefined, parent: null };
  }

  test("no-op when telemetry is disabled (no fetch, no throw)", async () => {
    let called = 0;
    globalThis.fetch = (async () => {
      called += 1;
      return new Response("{}");
    }) as unknown as typeof fetch;
    // dev version + no CLERK_TELEMETRY_URL → disabled
    startCommandTelemetry(fakeCommand());
    await finalizeAndSendTelemetry({ outcome: "success", exitCode: 0 });
    expect(called).toBe(0);
  });

  test("swallows network failures", async () => {
    process.env.CLERK_TELEMETRY_URL = "https://unreachable.invalid/v1/event";
    globalThis.fetch = (async () => {
      throw new Error("network down");
    }) as unknown as typeof fetch;
    startCommandTelemetry(fakeCommand());
    // Must resolve, not reject.
    await finalizeAndSendTelemetry({ outcome: "success", exitCode: 0 });
  });
});
