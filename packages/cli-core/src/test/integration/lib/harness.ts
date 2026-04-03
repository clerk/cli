/**
 * Shared setup for integration tests.
 *
 * Registers module mocks (must happen at import time, before dynamic imports),
 * exports controllable mock state, mock data, CLI harness, and
 * test harness setup/teardown functions.
 *
 * WARNING: Do NOT add static imports of modules that transitively import any
 * mocked module (credential-store, git, mode, inquirer, token-exchange,
 * auth-server, pkce). Bun's `mock.module()` must be registered before any
 * consumer loads the real module. All consuming imports must use dynamic
 * `await import(...)` AFTER the mock.module() calls below.
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

mock.module(
  "../../../lib/credential-store.ts",
  () =>
    ({
      getToken: async () => mockState.storedToken,
      storeToken: async (token: string) => {
        mockState.storedToken = token;
      },
      deleteToken: async () => {
        mockState.storedToken = null;
      },
      _setTokenOverride: () => {},
      KEYCHAIN_SERVICE: "clerk-cli",
      KEYCHAIN_ACCOUNT: "oauth-access-token",
    }) satisfies typeof import("../../../lib/credential-store.ts"),
);

mock.module(
  "../../../lib/git.ts",
  () =>
    ({
      getGitRepoRoot: async () => mockState.gitRepoRoot,
      getGitRepoIdentifier: async () => mockState.gitRepoIdentifier,
      getGitNormalizedRemote: async () => mockState.gitNormalizedRemote,
      normalizeGitRemoteUrl: (url: string) => url,
    }) satisfies typeof import("../../../lib/git.ts"),
);

let _mode: "human" | "agent" = "human";
mock.module(
  "../../../mode.ts",
  () =>
    ({
      getMode: () => _mode,
      setMode: (m: "human" | "agent") => {
        _mode = m;
      },
      isHuman: () => _mode === "human",
      isAgent: () => _mode === "agent",
    }) satisfies typeof import("../../../mode.ts"),
);

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

mock.module(
  "../../../lib/token-exchange.ts",
  () =>
    ({
      exchangeCodeForToken: async () => ({
        access_token: "mock_access_token",
        token_type: "Bearer",
        expires_in: 3600,
      }),
      fetchUserInfo: async (token: string) => {
        if (!token || token === "expired_token") throw new Error("Unauthorized");
        return { userId: "user_123", email: "test@example.com" };
      },
    }) satisfies typeof import("../../../lib/token-exchange.ts"),
);

mock.module(
  "../../../lib/auth-server.ts",
  () =>
    ({
      startAuthServer: () => ({
        port: 12345,
        waitForCallback: async () => ({ code: "mock_code" }),
        stop: () => {},
      }),
    }) satisfies typeof import("../../../lib/auth-server.ts"),
);

mock.module(
  "../../../lib/pkce.ts",
  () =>
    ({
      generateCodeVerifier: () => "mock_verifier",
      generateCodeChallenge: async () => "mock_challenge",
      generateState: () => "mock_state",
    }) satisfies typeof import("../../../lib/pkce.ts"),
);

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
  const program = createProgram();
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
      runProgram(program, args, { from: "user" }),
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
