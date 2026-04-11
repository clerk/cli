/**
 * Integration test scenarios.
 *
 * Provides multi-command deps factories, temp-dir helpers, mock data, and a
 * `clerk()` driver that exercises the full commander program (parsing,
 * bootstrap, global error handler, exit codes) against a `testRoot()` whose
 * collaborators are wired to in-memory state.
 *
 * Tests should pull `useIntegrationTestScenarios()`, `clerk`, and the mock
 * data exports from this file. The driver constructs a fresh `testRoot()`
 * per `clerk()` invocation with overrides closing over the per-test state
 * (storedToken, prompt queues, http fixture, temp-dir CLERK_CONFIG_DIR).
 *
 * Every lib collaborator is constructed via its factory and injected
 * through `testRoot()`. No `mock.module()` entries remain in this file.
 */

import { spyOn, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { capturedOutput } from "../../lib/stubs.ts";
import { withCapturedLogs } from "../../../lib/log.ts";
import { http } from "../../lib/http.ts";
import type { Application, ApplicationInstance } from "../../../lib/plapi.ts";
import type { Root } from "../../../lib/deps.ts";

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

// ── Harness-local git collaborator ───────────────────────────────────────────
//
// Closes over mockState so tests can mutate git state between `clerk()` calls.
// Replaces the previous `mock.module("lib/git.ts", ...)` entry; both
// `harnessConfigStore` (below) and the per-call `testRoot({ git })` override
// reuse this same instance so command and config-resolution git calls see
// identical state.

const harnessGit = {
  getGitRepoRoot: async () => mockState.gitRepoRoot,
  getGitRepoIdentifier: async () => mockState.gitRepoIdentifier,
  getGitNormalizedRemote: async () => mockState.gitNormalizedRemote,
  normalizeGitRemoteUrl: (url: string) => url,
};

// ── Prompt queue (consumed by `deps.prompts.*` in the testRoot shim) ────────

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
        `Unexpected call to deps.prompts.${name}() during test. ` +
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

// ── Real config module ───────────────────────────────────────────────────────
//
// Tests that pre-populate config (e.g. seeding a profile before invoking a
// command) import `readConfig`/`setProfile` from this module. The exports
// below are bound methods from a harness-local `ConfigStore` constructed via
// the factory, driven by a harness-local `Environment`. This is the same
// factory path the DI root uses, so the fixture data the tests seed is the
// same data the command sees through `deps.configStore.*`.

const { createEnvironment } = await import("../../../lib/environment.ts");
const { createPlapi } = await import("../../../lib/plapi.ts");
const { createConfig } = await import("../../../lib/config.ts");
const { _setConfigDir: _setConfigDirImpl } = await import("../../../lib/config.ts");

const harnessEnvironment = createEnvironment();
// The harness `credentialStore` closes over `mockState.storedToken` so the
// integration suite can read/set the stored token via mockState while ported
// commands route through `deps.credentialStore.*`.
const harnessCredentialStore = {
  getToken: async () => mockState.storedToken,
  storeToken: async (token: string) => {
    mockState.storedToken = token;
  },
  deleteToken: async () => {
    mockState.storedToken = null;
  },
};
const harnessPlapi = createPlapi(harnessEnvironment, harnessCredentialStore);
const harnessConfigStore = createConfig(harnessEnvironment, harnessPlapi, harnessGit);

export const _setConfigDir = _setConfigDirImpl;
export const readConfig = harnessConfigStore.readConfig;
export const setProfile = harnessConfigStore.setProfile;

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

// ── CLI driver ───────────────────────────────────────────────────────────────

let currentScenario: TestScenario | null = null;

export interface CLIResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

async function execCLI(...args: string[]): Promise<CLIResult> {
  const { createProgram, runProgram } = await import("../../../cli-program.ts");
  const { testRoot } = await import("../../lib/test-root.ts");
  const { bootstrap } = await import("../../../lib/bootstrap.ts");

  // Wire the testRoot for ported commands. Every lib collaborator is
  // constructed via its factory at file scope and injected here; no
  // `mock.module()` entries remain.
  const modeModule = await import("../../../mode.ts");
  const projectDetectorModule = await import("../../../lib/project-detector/index.ts");
  const bapiModule = await import("../../../commands/api/bapi.ts");
  const root = testRoot({
    // Inline credential-store as closures over mockState.storedToken so the
    // integration suite can read/set the stored token via mockState while
    // ported commands route through deps.credentialStore.* instead of the
    // real keychain-backed module.
    credentialStore: harnessCredentialStore,
    // configStore is the factory-constructed harness instance that reads and
    // writes the per-test temporary CLERK_CONFIG_DIR set by setupTest.
    configStore: harnessConfigStore,
    // tokenExchange is no longer file-level mocked. Inline deterministic
    // stubs for login flows so ported commands (e.g. login) run end-to-end.
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
      getPlapiBaseUrl: harnessEnvironment.getPlapiBaseUrl,
      getBapiBaseUrl: harnessEnvironment.getBapiBaseUrl,
      getCurrentEnvName: harnessEnvironment.getCurrentEnvName,
      setCurrentEnv: harnessEnvironment.setCurrentEnv,
      isValidEnv: harnessEnvironment.isValidEnv,
    },
    // Route logger output through console so the harness's logSpy/errorSpy
    // observe what ported commands write. Unported commands still use bare
    // console.* directly, so this only matters for the DI'd code paths.
    log: {
      // `log.data` is the pipeable-stdout method (e.g. `clerk apps list`,
      // agent prompts) so it routes to console.log → stdout in the harness.
      data: (msg) => console.log(msg),
      // Every other method is stderr-oriented; route to console.error so
      // the harness stderr capture sees it.
      info: (msg) => console.error(msg),
      success: (msg) => console.error(msg),
      warn: (msg) => console.error(msg),
      error: (msg) => console.error(msg),
      debug: (msg) => console.error(msg),
      raw: (msg) => console.error(msg),
      blank: () => console.error(""),
    },
    // git is the harness-local instance (see `harnessGit` above) so ported
    // commands read git state via deps.git and `harnessConfigStore` resolves
    // profiles against the same mockState values.
    git: harnessGit,
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
    // mode reads through the real `mode.ts` module. The global --mode flag is
    // parsed by `bootstrap()` (called via preParse below) which writes to the
    // module-level forcedMode singleton via setMode(); these getters then
    // surface that state through deps.mode.* for ported commands.
    mode: {
      getMode: modeModule.getMode,
      isHuman: modeModule.isHuman,
      isAgent: modeModule.isAgent,
    },
    // Route prompts directly to the FIFO mockPrompts queues. This bypasses
    // `lib/prompts.ts` (which calls @inquirer/prompts under the hood) so the
    // harness no longer needs the @inquirer/prompts mock.module entry. Tests
    // queue responses with mockPrompts.<name>(...) and the dequeue functions
    // throw a descriptive error if a prompt fires without a queued response.
    prompts: {
      confirm: dequeuePrompt("confirm") as Root["prompts"]["confirm"],
      search: dequeuePrompt("search") as Root["prompts"]["search"],
      select: dequeuePrompt("select") as Root["prompts"]["select"],
      input: dequeuePrompt("input") as Root["prompts"]["input"],
      password: dequeuePrompt("password") as Root["prompts"]["password"],
    },
    // spinner methods are no-op-friendly in tests; testRoot's defaults already
    // run callbacks via withSpinner and stub intro/outro/bar to no-op.
    // plapi makes real fetch calls; the http capture in setupTest mocks
    // global fetch so plapi calls hit the harness http fixture.
    plapi: harnessPlapi,
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

  if (!currentScenario) {
    throw new Error("clerk() called outside of setupTest/teardownTest lifecycle");
  }

  currentScenario.logSpy.mockClear();
  currentScenario.errorSpy.mockClear();
  currentScenario.exitSpy.mockClear();

  let exitCode = 0;

  // Capture module-level `log.*` output (from runProgram's error handler and
  // any non-DI code paths) into local buffers. The DI log overrides still
  // route through console.log/console.error, which the harness's logSpy and
  // errorSpy pick up. We merge both sources into stdout/stderr below.
  const captured = { stdout: [] as string[], stderr: [] as string[] };
  await withCapturedLogs(captured, async () => {
    try {
      await runProgram(program, args, {
        from: "user",
        preParse: () => bootstrap(root, args),
      });
    } catch (error: unknown) {
      if ((error as any)?.code?.startsWith?.("commander.")) {
        exitCode = (error as any).exitCode ?? 1;
      } else if (error instanceof Error && error.message === "process.exit") {
        const calls = currentScenario.exitSpy.mock.calls;
        exitCode = calls.length > 0 ? (calls[calls.length - 1][0] as number) : 1;
      } else {
        throw error;
      }
    }
  });

  const consoleStdout = capturedOutput(currentScenario.logSpy);
  const consoleStderr = capturedOutput(currentScenario.errorSpy);
  return {
    stdout: [consoleStdout, captured.stdout.join("\n")].filter(Boolean).join("\n"),
    stderr: [consoleStderr, captured.stderr.join("\n")].filter(Boolean).join("\n"),
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

// ── Scenario fixture ─────────────────────────────────────────────────────────

export interface TestScenario {
  tempDir: string;
  logSpy: ReturnType<typeof spyOn>;
  errorSpy: ReturnType<typeof spyOn>;
  exitSpy: ReturnType<typeof spyOn>;
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
export async function setupTest(): Promise<TestScenario> {
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

  const scenario = { tempDir, logSpy, errorSpy, exitSpy };
  currentScenario = scenario;
  return scenario;
}

/**
 * Tear down the test environment. Call in `afterEach`.
 *
 * Asserts prompt queues are empty, restores process state, and removes the
 * temporary directory.
 */
export async function teardownTest(scenario: TestScenario): Promise<void> {
  currentScenario = null;
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
  scenario.logSpy.mockRestore();
  scenario.errorSpy.mockRestore();
  scenario.exitSpy.mockRestore();
  await rm(scenario.tempDir, { recursive: true, force: true });
}

/**
 * Register `beforeEach`/`afterEach` hooks that set up and tear down the
 * integration test scenario fixture. Returns a proxy with a lazy `tempDir`
 * getter so tests can write files into the per-test temporary directory.
 *
 * @example
 * ```ts
 * const h = useIntegrationTestScenarios();
 * test("my test", async () => {
 *   await Bun.write(join(h.tempDir, "file.txt"), "hello");
 * });
 * ```
 */
export function useIntegrationTestScenarios() {
  let scenario: TestScenario;
  beforeEach(async () => {
    scenario = await setupTest();
  });
  afterEach(async () => {
    await teardownTest(scenario);
  });
  return {
    get tempDir() {
      return scenario.tempDir;
    },
  };
}
