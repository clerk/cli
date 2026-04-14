// packages/cli-core/src/test/lib/test-root.ts
/**
 * Shared test factory.
 *
 * Returns a fully-stubbed Root with three tiers of defaults:
 *
 * 1. Strict (high-risk): methods that throw by default. Tests must
 *    override these explicitly. Captures the regression class behind
 *    clerk/cli#86 (a test passes for the wrong reason because a default
 *    silently did something useful).
 *
 * 2. Conservative (read-only): methods that return null/empty/false.
 *    Tests override only when they need a non-trivial happy state.
 *
 * 3. Carve-outs: methods that need non-conservative defaults to make
 *    the test framework function at all (spinner.withSpinner must call
 *    its callback; log.* must be no-op; etc.).
 *
 * Every method (default or overridden) is auto-wrapped in mock() so
 * spies live on the deps object directly. A fresh root is returned
 * each call so spies never leak between tests.
 */

import { mock } from "bun:test";
import type { Root } from "../../lib/deps.ts";
import { createFakeSystem } from "../../lib/system.fake.ts";

type DeepPartial<T> = T extends object ? { [K in keyof T]?: DeepPartial<T[K]> } : T;

/** Build a stub that throws if called without an override.
 *
 * Returns an async function so the rejection surfaces as a Promise rejection
 * (not a synchronous throw). Most high-risk methods are async, and the few
 * sync ones (authServer.startAuthServer, env.require) are not normally
 * exercised in tests without an explicit override anyway.
 */
function strict<F extends (...args: never[]) => unknown>(name: string): F {
  return (async () => {
    throw new Error(
      `testRoot: ${name} called without override. This method is high-risk ` +
        `(network/subprocess/persisted-state/filesystem) and tests must explicitly ` +
        `stub it via testRoot({ ... }).`,
    );
  }) as unknown as F;
}

// Marks proxy-based defaults so the merge logic can detect them reliably.
// A heuristic on Object.getPrototypeOf is unreliable here because Bun's Proxy
// preserves the target prototype rather than reporting null.
const proxyDefaults = new WeakSet<object>();

function strictProxy<T extends object>(namespace: string): T {
  const proxy = new Proxy({} as T, {
    get: (_target, prop: string) => strict(`${namespace}.${prop}`),
  });
  proxyDefaults.add(proxy);
  return proxy;
}

const defaults: Root = {
  // ── credentialStore ────────────────────────────────────────────────
  credentialStore: {
    getToken: async () => null,
    storeToken: strict("credentialStore.storeToken"),
    deleteToken: strict("credentialStore.deleteToken"),
  },

  // ── configStore ────────────────────────────────────────────────────
  configStore: {
    readConfig: async () => ({ profiles: {} }),
    writeConfig: strict("configStore.writeConfig"),
    getAuth: async () => undefined,
    setAuth: strict("configStore.setAuth"),
    clearAuth: strict("configStore.clearAuth"),
    getEnvironment: async () => undefined,
    setEnvironment: strict("configStore.setEnvironment"),
    getProfile: async () => undefined,
    setProfile: strict("configStore.setProfile"),
    removeProfile: strict("configStore.removeProfile"),
    moveProfile: strict("configStore.moveProfile"),
    listProfiles: async () => ({}),
    resolveProfile: async () => undefined,
    resolveAppContext: strict("configStore.resolveAppContext"),
  },

  // ── git (subprocess) ───────────────────────────────────────────────
  git: {
    getGitRepoRoot: strict("git.getGitRepoRoot"),
    getGitRepoIdentifier: strict("git.getGitRepoIdentifier"),
    getGitNormalizedRemote: strict("git.getGitNormalizedRemote"),
    normalizeGitRemoteUrl: (u: string) => u,
  },

  // ── plapi (network); every method strict ───────────────────────────
  plapi: strictProxy<Root["plapi"]>("plapi"),

  // ── bapi (network); every method strict ────────────────────────────
  bapi: strictProxy<Root["bapi"]>("bapi"),

  // ── tokenExchange (network) ────────────────────────────────────────
  tokenExchange: {
    exchangeCodeForToken: strict("tokenExchange.exchangeCodeForToken"),
    fetchUserInfo: strict("tokenExchange.fetchUserInfo"),
  },

  // ── authServer (local HTTP server) ─────────────────────────────────
  authServer: {
    startAuthServer: strict("authServer.startAuthServer"),
  },

  // ── pkce (deterministic in tests) ──────────────────────────────────
  pkce: {
    generateCodeVerifier: () => "test-verifier",
    generateCodeChallenge: async () => "test-challenge",
    generateState: () => "test-state",
  },

  // ── prompts (no input) ─────────────────────────────────────────────
  prompts: {
    confirm: async () => false,
    select: strict("prompts.select"),
    search: strict("prompts.search"),
    input: strict("prompts.input"),
    password: strict("prompts.password"),
  },

  // ── mode (test default = human) ────────────────────────────────────
  mode: {
    getMode: () => "human",
    isHuman: () => true,
    isAgent: () => false,
  },

  // ── browser (subprocess) ───────────────────────────────────────────
  browser: {
    open: strict("browser.open"),
  },

  // ── system (subprocess; tests must override or queue results) ──────
  system: (() => {
    const fake = createFakeSystem();
    proxyDefaults.add(fake as unknown as object);
    return fake;
  })(),

  // ── spinner (UI side effects) ──────────────────────────────────────
  spinner: {
    intro: () => {},
    outro: () => {},
    bar: () => {},
    withSpinner: async <T>(_message: string, fn: () => Promise<T>, _doneMessage?: string) => fn(),
  },

  // ── log (UI side effects) ──────────────────────────────────────────
  log: {
    info: () => {},
    success: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
    data: () => {},
    raw: () => {},
    blank: () => {},
  },

  // ── env (process.env reads) ────────────────────────────────────────
  env: {
    get: () => undefined,
    require: strict("env.require"),
  },

  // ── environment (OAuth + active env) ───────────────────────────────
  environment: {
    setCurrentEnv: () => {},
    getCurrentEnvName: () => "production",
    getCurrentEnv: () => ({
      oauthClientId: "test-client",
      oauthBaseUrl: "https://accounts.test",
      platformApiUrl: "https://api.test",
      backendApiUrl: "https://api.test.dev",
    }),
    getAvailableEnvs: () => ["production"],
    isValidEnv: () => true,
    getOAuthConfig: () => ({
      clientId: "test-client",
      scopes: "openid email",
      authorizeUrl: "https://accounts.test/oauth/authorize",
      tokenUrl: "https://accounts.test/oauth/token",
      userinfoUrl: "https://accounts.test/oauth/userinfo",
    }),
    getPlapiBaseUrl: () => "https://api.test",
    getBapiBaseUrl: () => "https://api.test.dev",
    getDashboardUrl: () => "https://dashboard.test",
  },

  // ── projectDetector (filesystem) ───────────────────────────────────
  projectDetector: {
    gather: strict("projectDetector.gather"),
    hasPackageJson: strict("projectDetector.hasPackageJson"),
    fileExists: strict("projectDetector.fileExists"),
    dirExists: strict("projectDetector.dirExists"),
    readDeps: strict("projectDetector.readDeps"),
    detectFramework: strict("projectDetector.detectFramework"),
  },
};

export function testRoot(overrides: DeepPartial<Root> = {}): Root {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- dynamic property merging
  const root: any = {};
  for (const key of Object.keys(defaults) as (keyof Root)[]) {
    const defaultsForKey = defaults[key];
    const overridesForKey = (overrides[key] ?? {}) as Record<string, unknown>;
    // For Proxy-based defaults (plapi, bapi), preserve the Proxy and only
    // overlay overrides as a separate object that takes precedence.
    if (proxyDefaults.has(defaultsForKey as object)) {
      // Memoize mock wrappers so `deps.plapi.foo` returns the same mock
      // instance on every access (required for expect().toHaveBeenCalled()).
      const wrappedOverrides: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(overridesForKey)) {
        wrappedOverrides[k] = typeof v === "function" ? mock(v as never) : v;
      }
      root[key] = new Proxy(
        {},
        {
          get: (_target, prop: string) => {
            if (prop in wrappedOverrides) {
              return wrappedOverrides[prop];
            }
            return (defaultsForKey as unknown as Record<string, unknown>)[prop];
          },
        },
      );
      continue;
    }
    const merged = { ...(defaultsForKey as object), ...overridesForKey };
    root[key] = Object.fromEntries(
      Object.entries(merged).map(([k, v]) => [k, typeof v === "function" ? mock(v as never) : v]),
    );
  }
  return root as Root;
}
