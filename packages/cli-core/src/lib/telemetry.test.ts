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

  test.each([
    [{ CLERK_TELEMETRY_DISABLED: "1" }],
    [{ CLERK_TELEMETRY_DISABLED: "true" }],
    [{ DO_NOT_TRACK: "1" }],
    [{ DO_NOT_TRACK: "TRUE" }],
  ])("opt-out env %o disables", (env) => {
    expect(telemetryEnabled(env, REAL)).toBe(false);
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
  afterEach(() => {
    globalThis.fetch = originalFetch;
    delete process.env.CLERK_TELEMETRY_URL;
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
