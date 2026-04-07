/**
 * Shared setup for integration tests.
 *
 * Registers module mocks (must happen at import time, before dynamic imports),
 * exports controllable mock state, mock data, CLI harness, and
 * test harness setup/teardown functions.
 *
 * WARNING: Do NOT add static imports of modules that transitively import any
 * mocked module (credential-store, git, mode, inquirer). Bun's `mock.module()`
 * must be registered before any consumer loads the real module. All consuming
 * imports must use dynamic `await import(...)` AFTER the mock.module() calls
 * below.
 *
 * Ported (DI) commands no longer rely on `mock.module()` for token-exchange,
 * auth-server, or pkce; their stubs are inlined into `testRoot()` below.
 */

import { mock, spyOn, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { capturedOutput } from "../../lib/stubs.ts";
import { withCapturedLogs } from "../../../lib/log.ts";
import { http } from "../../lib/http.ts";
import type { Application, ApplicationInstance } from "../../../lib/plapi.ts";

export { capturedOutput, http };

// ── Controllable mock state ──────────────────────────────────────────────────

/**
 * Mutable state shared across module mocks. Tests can modify these values
 * between `clerk()` calls to simulate different environmental conditions.
 *
 * All values are reset to defaults in {@link setupTest}.
 */
export const mockState = {
  storedToken: "mock_token" as string | null,
  gitNormalizedRemote: "github.com/test/project" as string | undefined,
  gitRepoRoot: "/repo" as string | undefined,
  gitRepoIdentifier: "/repo/.git" as string | undefined,
};

// ── Module mocks (executed at import time) ───────────────────────────────────

mock.module("../../../lib/credential-store.ts", () => {
  const stubs = {
    getToken: async () => mockState.storedToken,
    storeToken: async (token: string) => {
      mockState.storedToken = token;
    },
    deleteToken: async () => {
      mockState.storedToken = null;
    },
  };
  return {
    ...stubs,
    _setTokenOverride: () => {},
    KEYCHAIN_SERVICE: "clerk-cli",
    KEYCHAIN_ACCOUNT: "oauth-access-token",
    // The `credentialStore` namespace export is consumed by `lib/root.ts`.
    credentialStore: stubs,
  } satisfies typeof import("../../../lib/credential-store.ts");
});

mock.module("../../../lib/git.ts", () => {
  const stubs = {
    getGitRepoRoot: async () => mockState.gitRepoRoot,
    getGitRepoIdentifier: async () => mockState.gitRepoIdentifier,
    getGitNormalizedRemote: async () => mockState.gitNormalizedRemote,
    normalizeGitRemoteUrl: (url: string) => url,
  };
  return {
    ...stubs,
    // The `git` namespace export is consumed by `lib/root.ts` and unported
    // command code paths (lib/config.ts, lib/autolink.ts) still import git
    // helpers directly. The mock.module entry will be removable once those
    // last raw consumers are ported.
    git: stubs,
  } satisfies typeof import("../../../lib/git.ts");
});

let _mode: "human" | "agent" = "human";
mock.module("../../../mode.ts", () => {
  const stubs = {
    getMode: () => _mode,
    isHuman: () => _mode === "human",
    isAgent: () => _mode === "agent",
  };
  return {
    ...stubs,
    setMode: (m: "human" | "agent") => {
      _mode = m;
    },
    // The `modeService` namespace export is consumed by `lib/root.ts`.
    modeService: stubs,
  } satisfies typeof import("../../../mode.ts");
});

// ── Prompt queue (replaces @inquirer/prompts) ────────────────────────────────

type PromptType = "select" | "search" | "input" | "confirm" | "password" | "editor";

const promptQueues: Record<PromptType, unknown[]> = {
  select: [],
  search: [],
  input: [],
  confirm: [],
  password: [],
  editor: [],
};

function dequeuePrompt(name: PromptType) {
  return async () => {
    const queue = promptQueues[name];
    if (queue.length === 0) {
      throw new Error(
        `Unexpected call to @inquirer/prompts.${name}() during test. ` +
          `Use a CLI flag (e.g. --yes) to bypass prompts, or queue a response with mockPrompts.${name}().`,
      );
    }
    return queue.shift();
  };
}

/**
 * Queue responses for `@inquirer/prompts` functions. Responses are consumed
 * in FIFO order — the first queued value is returned by the first call to
 * that prompt type, the second by the second call, and so on.
 *
 * If a prompt is called with no queued responses, the test fails immediately
 * with a descriptive error. Unconsumed responses are detected during
 * {@link teardownTest} and also fail the test.
 *
 * @example
 * ```ts
 * mockPrompts.confirm(true);        // first confirm() returns true
 * mockPrompts.confirm(false, true); // next two confirm() calls return false, then true
 * mockPrompts.select("app_1");      // first select() returns "app_1"
 * mockPrompts.input("hello");       // first input() returns "hello"
 * ```
 */
export const mockPrompts = {
  confirm: (...responses: boolean[]) => promptQueues.confirm.push(...responses),
  select: (...responses: unknown[]) => promptQueues.select.push(...responses),
  search: (...responses: unknown[]) => promptQueues.search.push(...responses),
  input: (...responses: string[]) => promptQueues.input.push(...responses),
  password: (...responses: string[]) => promptQueues.password.push(...responses),
  editor: (...responses: string[]) => promptQueues.editor.push(...responses),
};

function resetPromptQueues() {
  for (const queue of Object.values(promptQueues)) {
    queue.length = 0;
  }
}

function assertPromptQueuesEmpty() {
  for (const [name, queue] of Object.entries(promptQueues)) {
    if (queue.length > 0) {
      const count = queue.length;
      queue.length = 0;
      throw new Error(
        `${count} unconsumed mockPrompts.${name}() response(s). ` +
          `Remove stale mockPrompts.${name}() calls or verify the command hits the expected prompts.`,
      );
    }
  }
}

mock.module("@inquirer/prompts", () => ({
  select: dequeuePrompt("select"),
  search: dequeuePrompt("search"),
  input: dequeuePrompt("input"),
  confirm: dequeuePrompt("confirm"),
  password: dequeuePrompt("password"),
  editor: dequeuePrompt("editor"),
}));

// ── Real config module ───────────────────────────────────────────────────────

export const { _setConfigDir, readConfig, setProfile } = await import("../../../lib/config.ts");

// ── Mock data ────────────────────────────────────────────────────────────────

/**
 * Find the unique instance by environment type within an {@link Application}.
 * Throws if no matching instance exists or if multiple instances share the
 * same environment type, producing a clear test failure in either case.
 */
export function getInstance(app: Application, env: string): ApplicationInstance {
  const matches = app.instances.filter((i) => i.environment_type === env);
  if (matches.length === 0) {
    throw new Error(
      `No "${env}" instance found in application "${app.application_id}". ` +
        `Available: ${app.instances.map((i) => i.environment_type).join(", ")}`,
    );
  }
  if (matches.length > 1) {
    throw new Error(
      `Multiple "${env}" instances found in application "${app.application_id}" ` +
        `(${matches.map((i) => i.instance_id).join(", ")}). ` +
        `Expected exactly one.`,
    );
  }
  return matches[0]!;
}

export const MOCK_APP: Application = {
  application_id: "app_1",
  name: "My SaaS App",
  instances: [
    {
      instance_id: "ins_dev",
      environment_type: "development",
      secret_key: "sk_test_abc123",
      publishable_key: "pk_test_abc123",
    },
    {
      instance_id: "ins_prod",
      environment_type: "production",
      secret_key: "sk_live_xyz789",
      publishable_key: "pk_live_xyz789",
    },
  ],
};

export const MOCK_APP_DEV_ONLY: Application = {
  ...MOCK_APP,
  instances: [getInstance(MOCK_APP, "development")],
};

export const MOCK_APP_B: Application = {
  application_id: "app_B",
  name: "Other App",
  instances: [
    {
      instance_id: "ins_dev_b",
      environment_type: "development",
      secret_key: "sk_test_bbb111",
      publishable_key: "pk_test_bbb111",
    },
    {
      instance_id: "ins_prod_b",
      environment_type: "production",
      secret_key: "sk_live_bbb222",
      publishable_key: "pk_live_bbb222",
    },
  ],
};

/** Minimal subset of the Backend API user response. */
interface User {
  id: string;
  object: string;
  first_name: string;
  last_name: string;
  email_addresses: Array<{
    id: string;
    object: string;
    email_address: string;
    verification: { status: string };
  }>;
  created_at: number;
  updated_at: number;
}

/** Recursive JSON Schema node for instance configuration. */
interface ConfigSchema {
  type: string;
  properties?: Record<string, ConfigSchema>;
}

export const MOCK_USERS: User[] = [
  {
    id: "user_1",
    object: "user",
    first_name: "John",
    last_name: "Doe",
    email_addresses: [
      {
        id: "idn_1",
        object: "email_address",
        email_address: "john@example.com",
        verification: { status: "verified" },
      },
    ],
    created_at: 1700690400000,
    updated_at: 1700776800000,
  },
];

export const MOCK_CONFIG: Record<string, unknown> = {
  session: { lifetime: 604800 },
  sign_up: { mode: "public" },
  sign_in: { enabled: true },
};

export const MOCK_SCHEMA: ConfigSchema = {
  type: "object",
  properties: {
    session: { type: "object", properties: { lifetime: { type: "number" } } },
  },
};

// ── Env file assertions ──────────────────────────────────────────────────────

/**
 * Parse a `.env` file into a map of key-value pairs and assert no duplicate
 * keys exist. Throws if any environment variable name appears more than once,
 * catching append-instead-of-overwrite bugs.
 */
export function parseEnvFile(content: string, filePath: string): Map<string, string> {
  const env = new Map<string, string>();
  const duplicates: string[] = [];

  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    const eqIndex = trimmed.indexOf("=");
    if (eqIndex === -1) continue;

    const key = trimmed.slice(0, eqIndex);
    const value = trimmed.slice(eqIndex + 1);

    if (env.has(key)) {
      duplicates.push(key);
    }
    env.set(key, value);
  }

  if (duplicates.length > 0) {
    throw new Error(
      `Duplicate environment variable(s) in ${filePath}: ${duplicates.join(", ")}. ` +
        `The env file should update existing keys, not append duplicates.`,
    );
  }

  return env;
}

// ── CLI harness ──────────────────────────────────────────────────────────────

let currentHarness: TestHarness | null = null;

export interface CLIResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

async function execCLI(...args: string[]): Promise<CLIResult> {
  const { createProgram, runProgram } = await import("../../../cli-program.ts");
  const { testRoot } = await import("../../lib/test-root.ts");
  const { bootstrap } = await import("../../../lib/bootstrap.ts");

  // Bridge mocked module state into the Root for ported commands. As more
  // commands move to dependency injection, ported code paths read through
  // deps instead of the file-level mock.module() registrations. This wiring
  // keeps both worlds in sync until every command is ported and the
  // mock.module() shims can be deleted.
  const credentialStoreMock = await import("../../../lib/credential-store.ts");
  const configModule = await import("../../../lib/config.ts");
  const gitMock = await import("../../../lib/git.ts");
  const modeMock = await import("../../../mode.ts");
  const projectDetectorModule = await import("../../../lib/project-detector/index.ts");
  const promptsModule = await import("../../../lib/prompts.ts");
  const spinnerModule = await import("../../../lib/spinner.ts");
  const plapiModule = await import("../../../lib/plapi.ts");
  const bapiModule = await import("../../../commands/api/bapi.ts");
  const environmentModule = await import("../../../lib/environment.ts");
  const root = testRoot({
    credentialStore: {
      getToken: credentialStoreMock.getToken,
      storeToken: credentialStoreMock.storeToken,
      deleteToken: credentialStoreMock.deleteToken,
    },
    // configStore is backed by the real config module writing to the
    // per-test temporary CLERK_CONFIG_DIR set by setupTest.
    configStore: {
      readConfig: configModule.readConfig,
      writeConfig: configModule.writeConfig,
      getAuth: configModule.getAuth,
      setAuth: configModule.setAuth,
      clearAuth: configModule.clearAuth,
      getEnvironment: configModule.getEnvironment,
      setEnvironment: configModule.setEnvironment,
      getProfile: configModule.getProfile,
      setProfile: configModule.setProfile,
      removeProfile: configModule.removeProfile,
      moveProfile: configModule.moveProfile,
      listProfiles: configModule.listProfiles,
      resolveProfile: configModule.resolveProfile,
      resolveAppContext: configModule.resolveAppContext,
    },
    // tokenExchange is no longer file-level mocked. Inline the same stub
    // values the deleted mock.module() block previously provided.
    tokenExchange: {
      exchangeCodeForToken: async () => ({
        access_token: "mock_access_token",
        token_type: "Bearer",
        expires_in: 3600,
      }),
      fetchUserInfo: async (token: string) => {
        if (!token || token === "expired_token") throw new Error("Unauthorized");
        return { userId: "user_123", email: "test@example.com" };
      },
    },
    // authServer was also a file-level mock; inline the deterministic stub
    // so ported commands (e.g. login) can run end-to-end through clerk().
    authServer: {
      startAuthServer: () => ({
        port: 12345,
        waitForCallback: async () => ({ code: "mock_code" }),
        stop: () => {},
      }),
    },
    // pkce was also file-level mocked; inline the deterministic values.
    pkce: {
      generateCodeVerifier: () => "mock_verifier",
      generateCodeChallenge: async () => "mock_challenge",
      generateState: () => "mock_state",
    },
    // Browser launches a subprocess in the real implementation; stub it.
    browser: {
      open: async () => ({ ok: true }),
    },
    // Provide a deterministic OAuth config so login's URL construction is
    // independent of the real environment module's defaults, and bridge the
    // base URL getters so ported commands (api) honor the CLERK_*_API_URL
    // overrides set by setupTest.
    environment: {
      getOAuthConfig: () => ({
        clientId: "test-client-id",
        scopes: "profile email",
        authorizeUrl: "https://test.example.com/oauth/authorize",
        tokenUrl: "https://test.example.com/oauth/token",
        userinfoUrl: "https://test.example.com/oauth/userinfo",
      }),
      getPlapiBaseUrl: environmentModule.getPlapiBaseUrl,
      getBapiBaseUrl: environmentModule.getBapiBaseUrl,
    },
    // Route logger output through console so the harness's logSpy/errorSpy
    // observe what ported commands write. Unported commands still use bare
    // console.* directly, so this only matters for the DI'd code paths.
    log: {
      // `log.data` is the pipeable-stdout method (e.g. `clerk apps list`,
      // agent prompts) so it routes to console.log → stdout in the harness.
      /* oxlint-disable no-console -- test harness intentionally routes log to console */
      data: (msg: unknown) => console.log(msg),
      // Every other method is stderr-oriented; route to console.error so
      // the harness stderr capture sees it.
      info: (msg: unknown) => console.error(msg),
      success: (msg: unknown) => console.error(msg),
      warn: (msg: unknown) => console.error(msg),
      error: (msg: unknown) => console.error(msg),
      debug: (msg: unknown) => console.error(msg),
      raw: (msg: unknown) => console.error(msg),
      blank: () => console.error(""),
      /* oxlint-enable no-console */
    },
    // git is mock.module()-overridden at file load time. Bridge those stubs
    // through the testRoot shim so ported commands (link, unlink) read git
    // state via deps.git instead of touching the real git module.
    git: {
      getGitRepoRoot: gitMock.getGitRepoRoot,
      getGitRepoIdentifier: gitMock.getGitRepoIdentifier,
      getGitNormalizedRemote: gitMock.getGitNormalizedRemote,
      normalizeGitRemoteUrl: gitMock.normalizeGitRemoteUrl,
    },
    // projectDetector reads the temp dir directly, which is exactly what we
    // want in integration tests since setupTest sets process.cwd to a fresh
    // temp dir per test.
    projectDetector: {
      gather: projectDetectorModule.gather,
      fileExists: projectDetectorModule.fileExists,
      dirExists: projectDetectorModule.dirExists,
      readDeps: projectDetectorModule.readDeps,
      detectFramework: projectDetectorModule.detectFramework,
    },
    // mode is mock.module()-overridden so the global --mode flag set in argv
    // is reflected through deps.mode.* for ported commands.
    mode: {
      getMode: modeMock.getMode,
      isHuman: modeMock.isHuman,
      isAgent: modeMock.isAgent,
    },
    // prompts.confirm calls @inquirer/prompts.confirm internally, which is
    // already mock.module()-overridden in this harness to dequeue from the
    // mockPrompts queue. Bridging here lets ported commands use deps.prompts.
    prompts: {
      confirm: promptsModule.confirm,
      search: promptsModule.search,
      select: promptsModule.select,
      input: promptsModule.input,
      password: promptsModule.password,
    },
    // spinner methods are no-op-friendly in tests; the real implementations
    // print to stderr (captured) and run callbacks synchronously enough.
    spinner: {
      intro: spinnerModule.intro,
      outro: spinnerModule.outro,
      bar: spinnerModule.bar,
      withSpinner: spinnerModule.withSpinner,
    },
    // plapi makes real fetch calls; the http capture in setupTest mocks
    // global fetch so plapi calls hit the harness http fixture.
    plapi: {
      validateKeyPrefix: plapiModule.validateKeyPrefix,
      getAuthToken: plapiModule.getAuthToken,
      fetchInstanceConfigSchema: plapiModule.fetchInstanceConfigSchema,
      fetchInstanceConfig: plapiModule.fetchInstanceConfig,
      fetchApplication: plapiModule.fetchApplication,
      putInstanceConfig: plapiModule.putInstanceConfig,
      patchInstanceConfig: plapiModule.patchInstanceConfig,
      listApplications: plapiModule.listApplications,
    },
    // bapi also makes real fetch calls; the http fixture covers it too.
    bapi: {
      bapiRequest: bapiModule.bapiRequest,
    },
    // env wraps process.env reads. The harness sets CLERK_PLATFORM_API_KEY
    // and friends via setEnv() in setupTest, so the real getter is fine.
    env: {
      get: (name: string) => process.env[name],
    },
  });
  const program = createProgram(root);
  program.exitOverride();

  if (!currentHarness) {
    throw new Error("clerk() called outside of setupTest/teardownTest lifecycle");
  }

  currentHarness.logSpy.mockClear();
  currentHarness.errorSpy.mockClear();
  currentHarness.exitSpy.mockClear();
  currentHarness.captured.stdout.length = 0;
  currentHarness.captured.stderr.length = 0;

  let exitCode = 0;

  try {
    await withCapturedLogs(currentHarness.captured, () =>
      runProgram(program, args, {
        from: "user",
        preParse: () => bootstrap(args),
      }),
    );
  } catch (error: unknown) {
    if ((error as any)?.code?.startsWith?.("commander.")) {
      exitCode = (error as any).exitCode ?? 1;
    } else if (error instanceof Error && error.message === "process.exit") {
      const calls = currentHarness.exitSpy.mock.calls;
      exitCode = calls.length > 0 ? (calls[calls.length - 1][0] as number) : 1;
    } else {
      throw error;
    }
  }

  // Merge output from both console spies (non-migrated code) and scoped log capture.
  const consoleStdout = capturedOutput(currentHarness.logSpy);
  const consoleStderr = capturedOutput(currentHarness.errorSpy);
  const hookStdout = currentHarness.captured.stdout.join("\n");
  const hookStderr = currentHarness.captured.stderr.join("\n");

  return {
    stdout: [consoleStdout, hookStdout].filter(Boolean).join("\n"),
    stderr: [consoleStderr, hookStderr].filter(Boolean).join("\n"),
    exitCode,
  };
}

async function clerkStrict(...args: string[]): Promise<CLIResult> {
  const result = await execCLI(...args);
  if (result.exitCode !== 0) {
    throw new Error(
      `Command failed with exit code ${result.exitCode}\n` +
        `args: ${args.join(" ")}\n` +
        `stderr: ${result.stderr}`,
    );
  }
  return result;
}

clerkStrict.raw = execCLI;

/**
 * Execute a CLI command through commander's full parsing pipeline.
 *
 * **Strict mode (default):** Throws if the command exits non-zero.
 * **Raw mode (`clerk.raw`):** Always returns the result without throwing.
 */
export const clerk = clerkStrict;

// ── Test harness ─────────────────────────────────────────────────────────────

export interface TestHarness {
  tempDir: string;
  logSpy: ReturnType<typeof spyOn>;
  errorSpy: ReturnType<typeof spyOn>;
  exitSpy: ReturnType<typeof spyOn>;
  /** Output captured from log.* calls via the scoped capture context. */
  captured: { stdout: string[]; stderr: string[] };
}

const originalCwd = process.cwd;
const originalFetch = globalThis.fetch;
const originalStdinIsTTY = process.stdin.isTTY;

let envMutations: Map<string, string | undefined> = new Map();

function setEnv(key: string, value: string) {
  if (!envMutations.has(key)) {
    envMutations.set(key, process.env[key]);
  }
  process.env[key] = value;
}

/**
 * Initialize the test environment. Call in `beforeEach`.
 *
 * Creates a temporary directory, sets environment variables, resets mock state,
 * and installs console/process spies.
 */
export async function setupTest(): Promise<TestHarness> {
  const tempDir = await mkdtemp(join(tmpdir(), "clerk-integration-"));
  _setConfigDir(tempDir);
  process.cwd = () => tempDir;
  setEnv("CLERK_PLATFORM_API_KEY", "test_platform_key");
  setEnv("CLERK_PLATFORM_API_URL", "https://test-api.clerk.com");
  setEnv("CLERK_BACKEND_API_URL", "https://test-bapi.clerk.dev");
  mockState.storedToken = "mock_token";
  mockState.gitNormalizedRemote = "github.com/test/project";
  mockState.gitRepoRoot = "/repo";
  mockState.gitRepoIdentifier = "/repo/.git";
  resetPromptQueues();
  http.reset();
  process.stdin.isTTY = true;

  const logSpy = spyOn(console, "log").mockImplementation(() => {});
  const errorSpy = spyOn(console, "error").mockImplementation(() => {});
  const exitSpy = spyOn(process, "exit").mockImplementation(() => {
    throw new Error("process.exit");
  });

  const captured = { stdout: [] as string[], stderr: [] as string[] };
  const harness = { tempDir, logSpy, errorSpy, exitSpy, captured };
  currentHarness = harness;
  return harness;
}

/**
 * Tear down the test environment. Call in `afterEach`.
 *
 * Asserts prompt queues are empty, restores process state, and removes the
 * temporary directory.
 */
export async function teardownTest(harness: TestHarness): Promise<void> {
  currentHarness = null;
  assertPromptQueuesEmpty();
  http.assertRoutesConsumed();
  _setConfigDir(undefined);
  process.cwd = originalCwd;
  for (const [key, original] of envMutations) {
    if (original === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = original;
    }
  }
  envMutations = new Map();
  globalThis.fetch = originalFetch;
  process.stdin.isTTY = originalStdinIsTTY;
  harness.logSpy.mockRestore();
  harness.errorSpy.mockRestore();
  harness.exitSpy.mockRestore();
  await rm(harness.tempDir, { recursive: true, force: true });
}

/**
 * Register `beforeEach`/`afterEach` hooks that set up and tear down the
 * integration test harness. Returns a proxy with a lazy `tempDir` getter.
 *
 * @example
 * ```ts
 * const h = useIntegrationTestHarness();
 * test("my test", async () => {
 *   await Bun.write(join(h.tempDir, "file.txt"), "hello");
 * });
 * ```
 */
export function useIntegrationTestHarness() {
  let harness: TestHarness;
  beforeEach(async () => {
    harness = await setupTest();
  });
  afterEach(async () => {
    await teardownTest(harness);
  });
  return {
    get tempDir() {
      return harness.tempDir;
    },
  };
}
