import { Writable } from "node:stream";
import { afterEach, beforeEach, type spyOn } from "bun:test";
import { type CapturedLogs, setActiveCapture } from "../../lib/log.ts";
import { setUiOutput } from "../../lib/ui.ts";

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
  INSTANCE_ALIASES: {
    dev: "development",
    development: "development",
    prod: "production",
    production: "production",
  } as Record<string, "development" | "production">,
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
