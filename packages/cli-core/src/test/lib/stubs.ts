import { Writable } from "node:stream";
import { afterEach, beforeEach, type spyOn } from "bun:test";
import { type CapturedLogs, setActiveCapture } from "../../lib/log.ts";
import { setUiOutput } from "../../lib/ui.ts";
import type { TelemetryCommand, TelemetryResult } from "../../lib/telemetry.ts";

export function capturedOutput(spy: ReturnType<typeof spyOn>): string {
  return spy.mock.calls.map((c: unknown[]) => c[0]).join("\n");
}

/**
 * Capture `log.*` output for every test in the enclosing scope.
 *
 * Registers `beforeEach`/`afterEach` hooks that install a fresh buffer
 * before each test and clear it after. The returned proxy exposes getters
 * that always reflect the active test's buffer, plus a `clear()` helper
 * for ignoring setup noise mid-test.
 *
 * @example
 * ```ts
 * const captured = useCaptureLog();
 *
 * test("emits success", async () => {
 *   await myCommand();
 *   expect(captured.err).toContain("done");
 * });
 *
 * test("ignores setup noise", async () => {
 *   await setUp();
 *   captured.clear();
 *   await myCommand();
 *   expect(captured.err).toContain("done");
 * });
 * ```
 */
export function useCaptureLog() {
  let buf: CapturedLogs = { stdout: [], stderr: [] };
  beforeEach(() => {
    buf = { stdout: [], stderr: [] };
    setActiveCapture(buf);
  });
  afterEach(() => {
    setActiveCapture(null);
  });
  return {
    get stdout(): string[] {
      return buf.stdout;
    },
    get stderr(): string[] {
      return buf.stderr;
    },
    /** Joined stdout output. */
    get out(): string {
      return buf.stdout.join("\n");
    },
    /** Joined stderr output. */
    get err(): string {
      return buf.stderr.join("\n");
    },
    /** Reset the capture buffer mid-test (e.g., to ignore setup noise). */
    clear(): void {
      buf.stdout.length = 0;
      buf.stderr.length = 0;
    },
  };
}

export function captureLog() {
  const captured: CapturedLogs = { stdout: [], stderr: [] };
  return {
    ...captured,
    get out(): string {
      return captured.stdout.join("\n");
    },
    get err(): string {
      return captured.stderr.join("\n");
    },
    async run<T>(fn: () => T | Promise<T>): Promise<T> {
      setActiveCapture(captured);
      try {
        return await fn();
      } finally {
        setActiveCapture(null);
      }
    },
    teardown(): void {
      setActiveCapture(null);
    },
  };
}

class MockWritable extends Writable {
  buffer: string[] = [];
  isTTY = false;
  columns = 80;
  rows = 20;

  override _write(
    chunk: Buffer | string,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    this.buffer.push(typeof chunk === "string" ? chunk : chunk.toString());
    callback();
  }
}

/**
 * Route `ui.*` (clack-backed log helpers) output into an in-memory buffer.
 * Install in `beforeEach`, tear down in `afterEach`.
 */
export function captureUi() {
  const stream = new MockWritable();
  return {
    stream,
    get out() {
      return stream.buffer.join("");
    },
    install() {
      setUiOutput(stream);
    },
    teardown() {
      setUiOutput(undefined);
    },
  };
}

const noop = async () => {};

// Mocking a module replaces it wholesale, so this must cover every export of
// lib/config.ts — a missing name is an import error in any consumer, not just
// the one under test.
export const configStubs = {
  _setConfigDir: () => {},
  getConfigFile: () => "",
  readConfig: noop,
  writeConfig: noop,
  getAuth: noop,
  setAuth: noop,
  clearAuth: noop,
  getEnvironment: noop,
  setEnvironment: noop,
  getProfile: noop,
  setProfile: noop,
  removeProfile: noop,
  moveProfile: noop,
  listProfiles: noop,
  getRelayEntry: noop,
  setRelayEntry: noop,
  resolveProfile: noop,
  resolveProfileOrAutolink: noop,
  resolveInstanceId: () => ({ id: "", label: "" }),
  resolveFetchedApplicationInstance: () => ({
    found: false,
    instanceId: "",
    instanceLabel: "",
    instance: undefined,
  }),
  resolveAppContext: async () => ({ appId: "", appLabel: "", instanceId: "", instanceLabel: "" }),
  profileLabel: (profile: { appName?: string; appId: string }) =>
    profile.appName ? `${profile.appName} (${profile.appId})` : profile.appId,
  ensureMachineUuid: async () => "00000000-0000-4000-8000-000000000000",
  markTelemetryNoticeShown: async () => false,
  getTelemetryNoticeShown: async () => true,
  getTelemetryDisabled: async () => false,
  setTelemetryDisabled: noop,
};

// Same wholesale-replacement rule as configStubs: this must cover every
// export of lib/keyless-target.ts, or importing it anywhere in the process
// after the mock registers becomes an import error. Spread it into each
// `mock.module("../../lib/keyless-target.ts", ...)` and override the exports
// the file under test actually exercises.
export const keylessTargetStubs = {
  resolveKeylessTarget: noop,
  resolveInstanceTarget: noop,
  findLocalSecretKey: noop,
  findLocalPublishableKey: noop,
  hasKeyPairMismatch: async () => false,
  readSdkKeylessApp: noop,
};

export const autolinkStubs = {
  findClerkKeys: async () => [],
  matchKeyToApp: () => undefined,
  autolink: async () => undefined,
  linkApp: async () => undefined,
};

export const credentialStoreStubs = {
  getToken: async () => null,
  getValidToken: async () => null,
  getStoredSession: async () => null,
  hasStoredCredentials: async () => false,
  hasAccountCredentials: async () => Boolean(process.env.CLERK_PLATFORM_API_KEY),
  storeToken: async () => {},
  deleteToken: async () => {},
  revokeAndDeleteToken: async () => "nothing_to_revoke" as const,
  createOAuthSession: (tokenResponse: {
    access_token: string;
    refresh_token: string;
    expires_in: number;
    token_type: string;
  }) => ({
    accessToken: tokenResponse.access_token,
    refreshToken: tokenResponse.refresh_token,
    expiresAt: Date.now() + tokenResponse.expires_in * 1000,
    tokenType: tokenResponse.token_type,
  }),
};

export const gitStubs = {
  getGitRepoRoot: async () => undefined,
  getGitRepoIdentifier: async () => undefined,
  getGitNormalizedRemote: async () => undefined,
  normalizeGitRemoteUrl: (url: string) => url,
};

/**
 * Stubs for `lib/prompts.ts` — the @clack/prompts-backed wrapper. Default
 * responses return benign values so tests can mock the module without
 * configuring each prompt explicitly.
 */
export const libPromptsStubs = {
  confirm: async () => true,
  text: async () => "",
  password: async () => "",
  editor: async () => "{}",
};

export const promptsStubs = libPromptsStubs;

export { listageStubs } from "./listage-stubs.ts";

export const tokenExchangeStubs = {
  exchangeCodeForToken: async () => ({}),
  refreshAccessToken: async () => ({}),
  revokeToken: async () => "revoked" as const,
  fetchUserInfo: async () => ({}),
};

type FetchImpl = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export function stubFetch(impl: FetchImpl): void {
  globalThis.fetch = impl as typeof fetch;
}

/**
 * A stand-in for the Commander command telemetry reads, built from a space
 * separated command path as it appears in the payload: `"deploy status"`
 * yields a `status` command whose parent is `deploy`, whose parent is the
 * root `clerk`. No flags are reported as set.
 *
 * The root is synthesized rather than taken from `path` because telemetry
 * walks parents and stops at the one with no parent — it excludes the root
 * `clerk` from what it records. Without a root to discard, the leftmost
 * segment was discarded instead, so `"deploy status"` recorded `status` and
 * a single-segment `"deploy"` recorded the empty string.
 */
export function fakeTelemetryCommand(path: string): TelemetryCommand {
  const noOptions = { options: [] as never[], getOptionValueSource: () => undefined };
  return ["clerk", ...path.split(" ")].reduce<TelemetryCommand | null>(
    (parent, segment) => ({ name: () => segment, ...noOptions, parent }),
    null,
  ) as TelemetryCommand;
}

/** Where the helper below points telemetry; nothing else may answer on it. */
const TELEMETRY_CAPTURE_URL = "https://capture.invalid/v1/event";

type CaptureTelemetryOptions = {
  /**
   * Finalize with this instead of classifying what `run` did. A function is
   * resolved after `run`, so one derived from context sees what it declared.
   */
  result?: TelemetryResult | (() => TelemetryResult);
  /**
   * `run` is a command expected to report its own failure by throwing: the
   * throw is caught, classified by `telemetryResultForError`, and returned.
   * Without this a throw from `run` is a broken test and propagates.
   */
  captureError?: boolean;
};

/**
 * Run `run` inside a telemetry context for `command` and return the payload
 * of the one event finalizing it would post.
 *
 * Models the two `runProgram` branches that send an event: a throw is
 * classified by `telemetryResultForError` (opt in with `captureError`), a
 * normal return by `telemetryResultForSoftExit` reading `process.exitCode`
 * back. It does not model the third — a latched Ctrl-C, on which `runProgram`
 * sends nothing — so a test of a real interrupt must not expect a payload.
 *
 * Exactly one POST carrying exactly one event is required, which is the
 * one-terminal-event-per-run rule asserted rather than assumed. Only requests
 * to the capture URL count; anything else `run` fetches is delegated to
 * whatever `fetch` the caller already had installed.
 *
 * Self-contained on purpose. CI sets `CLERK_TELEMETRY_DISABLED` for every
 * job, and that opt-out beats the capture URL, so the opt-outs are cleared
 * for the duration; and several test files set `process.exitCode` without
 * resetting it, so it is cleared before `run` and restored after — otherwise
 * the soft-exit classification would read a leaked value. `fetch` and every
 * env var touched are restored in the same `finally`.
 */
export async function captureTelemetryPayload(
  command: string,
  run: () => void | Promise<void>,
  options: CaptureTelemetryOptions = {},
): Promise<{ payload: Record<string, unknown>; error: unknown }> {
  const { result, captureError = false } = options;
  if (result !== undefined && captureError) {
    throw new Error(
      "captureTelemetryPayload: `result` overrides classification, so `captureError` would do nothing",
    );
  }

  // Dynamic: a static import would load the real config module into every
  // test file that imports these stubs, including the ones that mock it.
  const { markTelemetryNoticeShown } = await import("../../lib/config.ts");
  const {
    finalizeAndSendTelemetry,
    startCommandTelemetry,
    telemetryResultForError,
    telemetryResultForSoftExit,
  } = await import("../../lib/telemetry.ts");
  const { EXIT_CODE } = await import("../../lib/errors.ts");

  const savedEnv = {
    CLERK_TELEMETRY_URL: process.env.CLERK_TELEMETRY_URL,
    CLERK_TELEMETRY_DISABLED: process.env.CLERK_TELEMETRY_DISABLED,
    DO_NOT_TRACK: process.env.DO_NOT_TRACK,
  };
  const savedFetch = globalThis.fetch;
  const savedExitCode = process.exitCode;
  const posted: string[] = [];
  try {
    await markTelemetryNoticeShown(); // past the grace run, which sends nothing
    process.env.CLERK_TELEMETRY_URL = TELEMETRY_CAPTURE_URL;
    delete process.env.CLERK_TELEMETRY_DISABLED;
    delete process.env.DO_NOT_TRACK;
    process.exitCode = undefined;
    globalThis.fetch = (async (url: unknown, init?: { body?: string }) => {
      if (String(url) !== TELEMETRY_CAPTURE_URL) {
        return savedFetch(url as Parameters<typeof fetch>[0], init as RequestInit);
      }
      posted.push(init?.body ?? "");
      return new Response("{}");
    }) as unknown as typeof fetch;

    startCommandTelemetry(fakeTelemetryCommand(command));
    let error: unknown;
    let threw = false;
    if (captureError) {
      try {
        await run();
      } catch (caught) {
        error = caught;
        threw = true;
      }
    } else {
      // A throw here is the test itself breaking, not the command reporting a
      // failure: let it out, and finalize nothing.
      await run();
    }

    const resolved = typeof result === "function" ? result() : result;
    await finalizeAndSendTelemetry(
      resolved ??
        (threw
          ? telemetryResultForError(error)
          : telemetryResultForSoftExit(Number(process.exitCode ?? EXIT_CODE.SUCCESS))),
    );

    if (posted.length !== 1) {
      throw new Error(`captureTelemetryPayload: expected 1 telemetry POST, got ${posted.length}`);
    }
    const parsed = JSON.parse(posted[0]!) as { events: { payload: Record<string, unknown> }[] };
    if (parsed.events.length !== 1) {
      throw new Error(
        `captureTelemetryPayload: expected 1 event in the POST, got ${parsed.events.length}`,
      );
    }
    return { payload: parsed.events[0]!.payload, error };
  } finally {
    globalThis.fetch = savedFetch;
    process.exitCode = savedExitCode;
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}
