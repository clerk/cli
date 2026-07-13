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

export const configStubs = {
  _setConfigDir: () => {},
  readConfig: noop,
  writeConfig: noop,
  getAuth: noop,
  setAuth: noop,
  clearAuth: noop,
  getProfile: noop,
  setProfile: noop,
  removeProfile: noop,
  moveProfile: noop,
  listProfiles: noop,
  resolveProfile: noop,
  resolveProfileOrAutolink: noop,
  resolveInstanceId: () => ({ id: "", label: "" }),
  resolveAppContext: async () => ({ appId: "", appLabel: "", instanceId: "", instanceLabel: "" }),
  isPrimaryInstance: (i: { parent_instance_id?: string }) => !i.parent_instance_id,
  getActiveInstanceForApp: noop,
  profileLabel: (profile: { appName?: string; appId: string }) =>
    profile.appName ? `${profile.appName} (${profile.appId})` : profile.appId,
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
  storeToken: async () => {},
  deleteToken: async () => {},
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
  fetchUserInfo: async () => ({}),
};

type FetchImpl = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export function stubFetch(impl: FetchImpl): void {
  globalThis.fetch = impl as typeof fetch;
}
