import type { spyOn } from "bun:test";
import { withCapturedLogs } from "../../lib/log.ts";

export function capturedOutput(spy: ReturnType<typeof spyOn>): string {
  return spy.mock.calls.map((c: unknown[]) => c[0]).join("\n");
}

/**
 * Create a scoped capture buffer for `log.*` calls.
 *
 * Use `run()` to execute code inside the capture context in unit tests that
 * exercise migrated commands (which use `log.*` instead of `console.log`/`console.error`).
 */
export function captureLog() {
  const captured = { stdout: [] as string[], stderr: [] as string[] };
  return {
    ...captured,
    /** Joined stdout output. */
    get out() {
      return captured.stdout.join("\n");
    },
    /** Joined stderr output. */
    get err() {
      return captured.stderr.join("\n");
    },
    run<T>(fn: () => T): T {
      return withCapturedLogs(captured, fn);
    },
    teardown() {
      // No-op: capture scope is tied to run(), not process-global state.
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
};

export const autolinkStubs = {
  findClerkKeys: async () => [],
  matchKeyToApp: () => undefined,
  autolink: async () => undefined,
};

export const credentialStoreStubs = {
  getToken: async () => null,
  storeToken: async () => {},
  deleteToken: async () => {},
};

export const gitStubs = {
  getGitRepoRoot: async () => undefined,
  getGitRepoIdentifier: async () => undefined,
  getGitNormalizedRemote: async () => undefined,
  normalizeGitRemoteUrl: (url: string) => url,
};

export const promptsStubs = {
  select: async () => undefined,
  search: async () => undefined,
  input: async () => "",
  confirm: async () => true,
  password: async () => "",
  editor: async () => "{}",
};

export { listageStubs } from "./listage-stubs.ts";

export const tokenExchangeStubs = {
  exchangeCodeForToken: async () => ({}),
  fetchUserInfo: async () => ({}),
};

type FetchImpl = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export function stubFetch(impl: FetchImpl): void {
  globalThis.fetch = impl as typeof fetch;
}
