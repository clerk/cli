import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEV_CLI_VERSION } from "./version.ts";
import { _setConfigDir, markTelemetryNoticeShown, setTelemetryDisabled } from "./config.ts";
import {
  finalizeAndSendTelemetry,
  getTelemetryStatus,
  startCommandTelemetry,
  telemetryEnabled,
  telemetryResultForError,
  type TelemetryCommand,
} from "./telemetry.ts";
import { ApiError, CliError, EXIT_CODE, UserAbortError } from "./errors.ts";
import { setLogLevel } from "./log.ts";
import { useCaptureLog } from "../test/lib/stubs.ts";

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

  // Any non-empty value except an explicit "0"/"false" opts out.
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

describe("getTelemetryStatus", () => {
  const REAL = "1.2.3";

  test("reports env opt-out first, naming the winning variable", async () => {
    expect(
      await getTelemetryStatus({ CLERK_TELEMETRY_DISABLED: "1", DO_NOT_TRACK: "1" }, REAL),
    ).toEqual({ enabled: false, reason: "env", envVar: "CLERK_TELEMETRY_DISABLED" });
    expect(await getTelemetryStatus({ DO_NOT_TRACK: "yes" }, REAL)).toEqual({
      enabled: false,
      reason: "env",
      envVar: "DO_NOT_TRACK",
    });
  });

  test("reports the persisted config opt-out", async () => {
    await setTelemetryDisabled(true);
    expect(await getTelemetryStatus({}, REAL)).toEqual({ enabled: false, reason: "config" });
  });

  test("persisted opt-out beats the URL escape hatch", async () => {
    await setTelemetryDisabled(true);
    const status = await getTelemetryStatus({ CLERK_TELEMETRY_URL: "http://localhost:9" }, REAL);
    expect(status.enabled).toBe(false);
  });

  test("reports dev builds, and enabled otherwise", async () => {
    expect(await getTelemetryStatus({}, DEV_CLI_VERSION)).toEqual({
      enabled: false,
      reason: "dev-build",
    });
    expect(await getTelemetryStatus({}, REAL)).toEqual({ enabled: true });
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

  test("no send when telemetry is disabled via persisted config", async () => {
    let called = 0;
    globalThis.fetch = (async () => {
      called += 1;
      return new Response("{}");
    }) as unknown as typeof fetch;
    process.env.CLERK_TELEMETRY_URL = "https://capture.invalid/v1/event";
    await setTelemetryDisabled(true);
    startCommandTelemetry(fakeCommand());
    await finalizeAndSendTelemetry({ outcome: "success", exitCode: 0 });
    expect(called).toBe(0);
  });

  describe("verbose payload dump", () => {
    const captured = useCaptureLog();

    test("dumps the event payload at debug level before the POST", async () => {
      globalThis.fetch = (async () => new Response("{}")) as unknown as typeof fetch;
      process.env.CLERK_TELEMETRY_URL = "https://capture.invalid/v1/event";
      // Agent-mode run (no TTY in tests) → notice path skipped, event sends.
      setLogLevel("debug");
      try {
        startCommandTelemetry(fakeCommand());
        await finalizeAndSendTelemetry({ outcome: "success", exitCode: 0 });
      } finally {
        setLogLevel("info");
      }
      expect(captured.err).toContain("telemetry: event {");
      expect(captured.err).toContain('"machine_uuid"');
    });
  });

  describe("first-run notice (human, non-CI)", () => {
    const captured = useCaptureLog();
    let originalCi: string | undefined;
    let originalMode: string | undefined;

    beforeEach(() => {
      originalCi = process.env.CI;
      originalMode = process.env.CLERK_MODE;
      delete process.env.CI;
      process.env.CLERK_MODE = "human";
      process.env.CLERK_TELEMETRY_URL = "https://capture.invalid/v1/event";
    });
    afterEach(() => {
      if (originalCi === undefined) delete process.env.CI;
      else process.env.CI = originalCi;
      if (originalMode === undefined) delete process.env.CLERK_MODE;
      else process.env.CLERK_MODE = originalMode;
    });

    test("the run that shows the notice sends nothing; the next run sends", async () => {
      let called = 0;
      globalThis.fetch = (async () => {
        called += 1;
        return new Response("{}");
      }) as unknown as typeof fetch;

      startCommandTelemetry(fakeCommand());
      await finalizeAndSendTelemetry({ outcome: "success", exitCode: 0 });
      expect(called).toBe(0);
      expect(captured.err).toContain("Nothing has been sent during this run");

      startCommandTelemetry(fakeCommand());
      await finalizeAndSendTelemetry({ outcome: "success", exitCode: 0 });
      expect(called).toBe(1);
    });

    test("no notice and no skip once it has already been shown", async () => {
      await markTelemetryNoticeShown();
      let called = 0;
      globalThis.fetch = (async () => {
        called += 1;
        return new Response("{}");
      }) as unknown as typeof fetch;

      startCommandTelemetry(fakeCommand());
      await finalizeAndSendTelemetry({ outcome: "success", exitCode: 0 });
      expect(called).toBe(1);
      expect(captured.err).not.toContain("usage telemetry");
    });
  });
});
