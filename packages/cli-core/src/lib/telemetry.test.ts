import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { _setConfigDir, markTelemetryNoticeShown, setTelemetryDisabled } from "./config.ts";
import {
  declareSoftExitOutcome,
  finalizeAndSendTelemetry,
  getTelemetryStatus,
  setTelemetryPauseStep,
  setTelemetryDomainComponents,
  setTelemetryOAuthComplete,
  setTelemetryStage,
  startCommandTelemetry,
  telemetryEnabled,
  telemetryResultForError,
  telemetryResultForSoftExit,
  type TelemetryCommand,
  type TelemetryResult,
} from "./telemetry.ts";
import { ApiError, CliError, ERROR_CODE, EXIT_CODE, UserAbortError } from "./errors.ts";
import { abortInFlight, beginInterrupt, _resetInterruptState } from "./signals.ts";
import { setLogLevel } from "./log.ts";
import { captureTelemetryPayload, fakeTelemetryCommand, useCaptureLog } from "../test/lib/stubs.ts";

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
  const RELEASE_BUILD = false;

  test("enabled for release builds by default", () => {
    expect(telemetryEnabled({}, RELEASE_BUILD)).toBe(true);
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
    expect(telemetryEnabled(env, RELEASE_BUILD)).toBe(false);
  });

  test.each([
    [{ CLERK_TELEMETRY_DISABLED: "0" }],
    [{ CLERK_TELEMETRY_DISABLED: "false" }],
    [{ CLERK_TELEMETRY_DISABLED: "FALSE" }],
    [{ CLERK_TELEMETRY_DISABLED: "" }],
    [{ DO_NOT_TRACK: "0" }],
    [{ DO_NOT_TRACK: "false" }],
  ])("explicit-false env %o stays enabled", (env) => {
    expect(telemetryEnabled(env, RELEASE_BUILD)).toBe(true);
  });

  test("dev builds are disabled unless CLERK_TELEMETRY_URL is set", () => {
    expect(telemetryEnabled({}, true)).toBe(false);
    expect(telemetryEnabled({ CLERK_TELEMETRY_URL: "http://localhost:9" }, true)).toBe(true);
  });

  test("opt-out beats the URL escape hatch", () => {
    expect(
      telemetryEnabled(
        { CLERK_TELEMETRY_URL: "http://localhost:9", DO_NOT_TRACK: "1" },
        RELEASE_BUILD,
      ),
    ).toBe(false);
  });
});

describe("getTelemetryStatus", () => {
  const RELEASE_BUILD = false;

  test("reports env opt-out first, naming the winning variable", async () => {
    expect(
      await getTelemetryStatus({ CLERK_TELEMETRY_DISABLED: "1", DO_NOT_TRACK: "1" }, RELEASE_BUILD),
    ).toEqual({ enabled: false, reason: "env", envVar: "CLERK_TELEMETRY_DISABLED" });
    expect(await getTelemetryStatus({ DO_NOT_TRACK: "yes" }, RELEASE_BUILD)).toEqual({
      enabled: false,
      reason: "env",
      envVar: "DO_NOT_TRACK",
    });
  });

  test("reports the persisted config opt-out", async () => {
    await setTelemetryDisabled(true);
    expect(await getTelemetryStatus({}, RELEASE_BUILD)).toEqual({
      enabled: false,
      reason: "config",
    });
  });

  test("persisted opt-out beats the URL escape hatch", async () => {
    await setTelemetryDisabled(true);
    const status = await getTelemetryStatus(
      { CLERK_TELEMETRY_URL: "http://localhost:9" },
      RELEASE_BUILD,
    );
    expect(status.enabled).toBe(false);
  });

  test("reports dev builds, and enabled otherwise", async () => {
    expect(await getTelemetryStatus({}, true)).toEqual({
      enabled: false,
      reason: "dev-build",
    });
    expect(await getTelemetryStatus({}, RELEASE_BUILD)).toEqual({ enabled: true });
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
    return fakeTelemetryCommand("list");
  }

  /** Captures the payload of the single event a finalize call sends. */
  async function sendAndCapturePayload(
    run: () => void | Promise<void>,
    result: TelemetryResult | (() => TelemetryResult),
  ): Promise<Record<string, unknown>> {
    return (await captureTelemetryPayload("list", run, { result })).payload;
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
    await markTelemetryNoticeShown(); // past the grace run — reach the send path
    process.env.CLERK_TELEMETRY_URL = "https://unreachable.invalid/v1/event";
    globalThis.fetch = (async () => {
      throw new Error("network down");
    }) as unknown as typeof fetch;
    startCommandTelemetry(fakeCommand());
    // Must resolve, not reject.
    await finalizeAndSendTelemetry({ outcome: "success", exitCode: 0 });
  });

  test("the deadline bounds the whole telemetry job, not just the fetch", async () => {
    await markTelemetryNoticeShown();
    process.env.CLERK_TELEMETRY_URL = "https://capture.invalid/v1/event";
    globalThis.fetch = (() => new Promise(() => {})) as unknown as typeof fetch; // hangs forever
    startCommandTelemetry(fakeCommand());
    const started = Date.now();
    await finalizeAndSendTelemetry({ outcome: "success", exitCode: 0 }, 100);
    expect(Date.now() - started).toBeLessThan(500);
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

  // A run gets one event across both flushes: the normal end-of-command one and
  // the shutdown one the SIGINT handler starts.
  describe("interrupted runs", () => {
    afterEach(() => {
      _resetInterruptState();
    });

    /** Lands the abort event; the success event only ever settles by aborting. */
    function fetchThatOnlyLandsAborts(landed: string[]): typeof fetch {
      return (async (_url: string, init?: RequestInit) => {
        const body = String(init?.body ?? "");
        if (body.includes('"outcome":"abort"')) {
          landed.push(body);
          return new Response("{}");
        }
        return new Promise<Response>((_resolve, reject) => {
          const fail = () => reject(new DOMException("The operation was aborted.", "AbortError"));
          const signal = init?.signal;
          if (!signal) return;
          if (signal.aborted) return fail();
          signal.addEventListener("abort", fail, { once: true });
        });
      }) as unknown as typeof fetch;
    }

    test("an aborted normal flush leaves the run for the shutdown flush to report", async () => {
      await markTelemetryNoticeShown();
      process.env.CLERK_TELEMETRY_URL = "https://capture.invalid/v1/event";
      const landed: string[] = [];
      globalThis.fetch = fetchThatOnlyLandsAborts(landed);
      startCommandTelemetry(fakeCommand());

      beginInterrupt();
      abortInFlight();
      await finalizeAndSendTelemetry({ outcome: "success", exitCode: 0 }, 1000);
      expect(landed).toEqual([]);

      await finalizeAndSendTelemetry({ outcome: "abort", exitCode: EXIT_CODE.SIGINT }, 250, true);

      expect(landed).toHaveLength(1);
      expect(landed[0]).toContain('"outcome":"abort"');
    });

    test("a flush still in flight when the interrupt lands still yields one event", async () => {
      await markTelemetryNoticeShown();
      process.env.CLERK_TELEMETRY_URL = "https://capture.invalid/v1/event";
      const landed: string[] = [];
      globalThis.fetch = fetchThatOnlyLandsAborts(landed);
      startCommandTelemetry(fakeCommand());

      const normal = finalizeAndSendTelemetry({ outcome: "success", exitCode: 0 }, 1000);
      beginInterrupt();
      abortInFlight();
      await finalizeAndSendTelemetry({ outcome: "abort", exitCode: EXIT_CODE.SIGINT }, 250, true);
      await normal;

      expect(landed).toHaveLength(1);
      expect(landed[0]).toContain('"outcome":"abort"');
    });

    test("the shutdown flush is not held up by a normal flush that ignores the interrupt", async () => {
      await markTelemetryNoticeShown();
      process.env.CLERK_TELEMETRY_URL = "https://capture.invalid/v1/event";
      const landed: string[] = [];
      globalThis.fetch = (async (_url: string, init?: RequestInit) => {
        const body = String(init?.body ?? "");
        if (body.includes('"outcome":"abort"')) {
          landed.push(body);
          return new Response("{}");
        }
        // Stands in for the config, Git, and user-agent reads a normal flush
        // does around its POST: slow, and blind to the interrupt signal.
        return new Promise<Response>(() => {});
      }) as unknown as typeof fetch;
      startCommandTelemetry(fakeCommand());

      const normal = finalizeAndSendTelemetry({ outcome: "success", exitCode: 0 }, 300);
      beginInterrupt();
      abortInFlight();
      await finalizeAndSendTelemetry({ outcome: "abort", exitCode: EXIT_CODE.SIGINT }, 250, true);

      // Landed inside the shutdown budget rather than being starved by work
      // the interrupt cannot cancel.
      expect(landed).toHaveLength(1);
      await normal;
    });

    test("a landed normal flush is not reported a second time", async () => {
      await markTelemetryNoticeShown();
      process.env.CLERK_TELEMETRY_URL = "https://capture.invalid/v1/event";
      const bodies: string[] = [];
      globalThis.fetch = (async (_url: string, init?: RequestInit) => {
        bodies.push(String(init?.body ?? ""));
        return new Response("{}");
      }) as unknown as typeof fetch;
      startCommandTelemetry(fakeCommand());

      await finalizeAndSendTelemetry({ outcome: "success", exitCode: 0 });
      await finalizeAndSendTelemetry({ outcome: "abort", exitCode: EXIT_CODE.SIGINT }, 250, true);

      expect(bodies).toHaveLength(1);
      expect(bodies[0]).toContain('"outcome":"success"');
    });
  });

  describe("sandbox-looking failures", () => {
    const captured = useCaptureLog();

    test("permission-shaped telemetry failures never trigger the sandbox warning", async () => {
      await markTelemetryNoticeShown();
      process.env.CLERK_TELEMETRY_URL = "https://capture.invalid/v1/event";
      globalThis.fetch = (async () => {
        throw new Error("EPERM: operation not permitted");
      }) as unknown as typeof fetch;
      // Agent mode (no TTY in tests) — the mode where the sandbox hint fires.
      startCommandTelemetry(fakeCommand());
      await finalizeAndSendTelemetry({ outcome: "success", exitCode: 0 });
      expect(captured.err).not.toContain("Host-only");
    });
  });

  describe("verbose payload dump", () => {
    const captured = useCaptureLog();

    test("dumps the event payload at debug level before the POST", async () => {
      await markTelemetryNoticeShown();
      globalThis.fetch = (async () => new Response("{}")) as unknown as typeof fetch;
      process.env.CLERK_TELEMETRY_URL = "https://capture.invalid/v1/event";
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

  describe("first-run notice (agent mode, non-CI)", () => {
    const captured = useCaptureLog();
    let originalCi: string | undefined;

    beforeEach(() => {
      originalCi = process.env.CI;
      delete process.env.CI;
      process.env.CLERK_TELEMETRY_URL = "https://capture.invalid/v1/event";
    });
    afterEach(() => {
      if (originalCi === undefined) delete process.env.CI;
      else process.env.CI = originalCi;
    });

    test("agents get the notice and the no-send grace run too", async () => {
      let called = 0;
      globalThis.fetch = (async () => {
        called += 1;
        return new Response("{}");
      }) as unknown as typeof fetch;

      // No CLERK_MODE and no TTY in tests → agent mode.
      startCommandTelemetry(fakeCommand());
      await finalizeAndSendTelemetry({ outcome: "success", exitCode: 0 });
      expect(called).toBe(0);
      expect(captured.err).toContain("Nothing has been sent during this run");

      startCommandTelemetry(fakeCommand());
      await finalizeAndSendTelemetry({ outcome: "success", exitCode: 0 });
      expect(called).toBe(1);
    });

    test("CI sends from the first run with no notice", async () => {
      process.env.CI = "true";
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

  describe("stage", () => {
    test("reports the furthest stage reached on success", async () => {
      const payload = await sendAndCapturePayload(
        () => {
          setTelemetryStage("detect");
          setTelemetryStage("scaffold");
          setTelemetryStage("done");
        },
        { outcome: "success", exitCode: 0 },
      );
      expect(payload.stage).toBe("done");
    });

    test("reports where an error stopped the command", async () => {
      const payload = await sendAndCapturePayload(
        () => {
          setTelemetryStage("detect");
          setTelemetryStage("bootstrap");
        },
        telemetryResultForError(new CliError("boom", { code: ERROR_CODE.GENERATOR_FAILED })),
      );
      expect(payload.stage).toBe("bootstrap");
      expect(payload.error_code).toBe("generator_failed");
    });

    // The whole point of stage: an abort is a drop-off, and drop-offs are only
    // legible if you can see which step the user backed out of.
    test("reports the stage on abort", async () => {
      const payload = await sendAndCapturePayload(
        () => setTelemetryStage("scaffold"),
        telemetryResultForError(new UserAbortError()),
      );
      expect(payload.outcome).toBe("abort");
      expect(payload.stage).toBe("scaffold");
    });

    test("stage is null when the command never sets one", async () => {
      const payload = await sendAndCapturePayload(() => {}, { outcome: "success", exitCode: 0 });
      expect(payload.stage).toBeNull();
    });

    test("setting a stage with no active context is a no-op", () => {
      expect(() => setTelemetryStage("flags")).not.toThrow();
    });
  });

  // Four booleans from two reads. Each setter owns its group and must not
  // touch the other: a domain poll that re-sent OAuth would either blank a
  // good observation or repeat a stale one.
  describe("components", () => {
    const success = { outcome: "success" as const, exitCode: 0 };

    test("null until observed", async () => {
      const payload = await sendAndCapturePayload(() => {}, success);
      expect(payload.components).toEqual({ dns: null, ssl: null, mail: null, oauth: null });
    });

    test("the domain setter leaves oauth alone", async () => {
      const payload = await sendAndCapturePayload(
        () => setTelemetryDomainComponents({ dns: true, ssl: false, mail: true }),
        success,
      );
      expect(payload.components).toEqual({ dns: true, ssl: false, mail: true, oauth: null });
    });

    test("the oauth setter leaves the domain group alone", async () => {
      const payload = await sendAndCapturePayload(() => setTelemetryOAuthComplete(false), success);
      expect(payload.components).toEqual({ dns: null, ssl: null, mail: null, oauth: false });
    });

    test("within a group the last write wins, across groups each keeps its own", async () => {
      const payload = await sendAndCapturePayload(() => {
        setTelemetryOAuthComplete(true);
        setTelemetryDomainComponents({ dns: false, ssl: false, mail: false });
        setTelemetryDomainComponents({ dns: true, ssl: false, mail: true });
      }, success);
      expect(payload.components).toEqual({ dns: true, ssl: false, mail: true, oauth: true });
    });

    test("does not leak into the next run", async () => {
      await sendAndCapturePayload(() => {
        setTelemetryOAuthComplete(true);
        setTelemetryDomainComponents({ dns: true, ssl: true, mail: true });
      }, success);

      const payload = await sendAndCapturePayload(() => {}, success);
      expect(payload.components).toEqual({ dns: null, ssl: null, mail: null, oauth: null });
    });

    test("setting with no active context is a no-op", () => {
      expect(() =>
        setTelemetryDomainComponents({ dns: true, ssl: true, mail: true }),
      ).not.toThrow();
      expect(() => setTelemetryOAuthComplete(true)).not.toThrow();
    });
  });

  // A command that reports failure through `process.exitCode` never reaches
  // `telemetryResultForError`, so without a declaration the only thing the
  // soft-exit branch can say is "nonzero, therefore error".
  describe("soft-exit declarations", () => {
    test("a declared outcome is recorded when the exit code is nonzero", async () => {
      const payload = await sendAndCapturePayload(
        () => declareSoftExitOutcome("incomplete"),
        () => telemetryResultForSoftExit(EXIT_CODE.GENERAL),
      );
      expect(payload.outcome).toBe("incomplete");
      expect(payload.exit_code).toBe(EXIT_CODE.GENERAL);
      expect(payload.error_code).toBeNull();
    });

    // The declaration says what a *failure* meant. A run that ended at 0 did
    // not fail, and honoring a stale declaration would invent one.
    test("a declared outcome is ignored when the run exits 0", async () => {
      const payload = await sendAndCapturePayload(
        () => declareSoftExitOutcome("incomplete"),
        () => telemetryResultForSoftExit(EXIT_CODE.SUCCESS),
      );
      expect(payload.outcome).toBe("success");
    });

    test("an undeclared nonzero soft exit is still an error", async () => {
      const payload = await sendAndCapturePayload(
        () => {},
        () => telemetryResultForSoftExit(EXIT_CODE.GENERAL),
      );
      expect(payload.outcome).toBe("error");
      expect(payload.error_code).toBeNull();
    });

    // The shape M7 extends: `clerk api` holds a code its own catch swallowed.
    test("a declaration can carry an error code", () => {
      startCommandTelemetry(fakeCommand());
      declareSoftExitOutcome("error", "api_not_found");
      expect(telemetryResultForSoftExit(EXIT_CODE.GENERAL)).toEqual({
        outcome: "error",
        exitCode: EXIT_CODE.GENERAL,
        errorCode: "api_not_found",
      });
    });

    // What the send does with a result it is handed while a declaration is
    // live: it uses the result. Resolved through the callback so the two call
    // sites read alike, and so this keeps holding if `telemetryResultForError`
    // ever starts reading context — it is pure today, so the ordering itself
    // makes no difference.
    test("a thrown error keeps its own code regardless of a declaration", async () => {
      const payload = await sendAndCapturePayload(
        () => declareSoftExitOutcome("incomplete"),
        () => telemetryResultForError(new CliError("boom", { code: ERROR_CODE.NOT_LINKED })),
      );
      expect(payload.outcome).toBe("error");
      expect(payload.error_code).toBe("not_linked");
    });

    // Tests share the module, and so would two runs in one process: a stale
    // declaration would relabel the next command's failure.
    test("a declaration does not leak into the next run", () => {
      startCommandTelemetry(fakeCommand());
      declareSoftExitOutcome("incomplete");
      startCommandTelemetry(fakeCommand());
      expect(telemetryResultForSoftExit(EXIT_CODE.GENERAL)).toEqual({
        outcome: "error",
        exitCode: EXIT_CODE.GENERAL,
      });
    });

    test("declaring with no active context is a no-op", () => {
      expect(() => declareSoftExitOutcome("incomplete")).not.toThrow();
    });
  });

  // The warehouse parses this payload by key. A rename splits a column in two
  // without failing anything here, so the key set itself is the contract.
  describe("payload shape", () => {
    test("carries exactly the agreed keys", async () => {
      const payload = await sendAndCapturePayload(() => {}, { outcome: "success", exitCode: 0 });
      expect(payload.command).toBe("list");
      expect(Object.keys(payload).sort()).toEqual(
        [
          "ai_agent",
          "app_id",
          "arch",
          "ci",
          "command",
          "components",
          "duration_ms",
          "env",
          "error_code",
          "exit_code",
          "flags",
          "in_screen",
          "in_tmux",
          "install_method",
          "machine_uuid",
          "mode",
          "os",
          "outcome",
          "pause_step",
          "stage",
          "terminal_program",
          "workspace_id",
        ].sort(),
      );
    });

    // Declared in M3 so the shape is fixed once; the wizard fills them in
    // later milestones. Null means never observed, and the warehouse reads it
    // that way — it must not arrive as `false` or as an absent key.
    test("the fields later milestones fill are present and null", async () => {
      const payload = await sendAndCapturePayload(() => {}, { outcome: "success", exitCode: 0 });
      expect(payload.pause_step).toBeNull();
      expect(payload.components).toEqual({ dns: null, ssl: null, mail: null, oauth: null });
    });
  });

  describe("pause step", () => {
    test("the step a run stopped on reaches the payload", async () => {
      const payload = await sendAndCapturePayload(() => setTelemetryPauseStep("oauth"), {
        outcome: "error",
        exitCode: EXIT_CODE.GENERAL,
      });
      expect(payload.pause_step).toBe("oauth");
    });

    // A resume enters OAuth setup after the DNS handoff, so both steps can be
    // reached in one run; the one the run actually stopped on is the last set.
    test("the last step set is the one sent", async () => {
      const payload = await sendAndCapturePayload(
        () => {
          setTelemetryPauseStep("dns");
          setTelemetryPauseStep("oauth");
        },
        { outcome: "error", exitCode: EXIT_CODE.GENERAL },
      );
      expect(payload.pause_step).toBe("oauth");
    });
  });
});
