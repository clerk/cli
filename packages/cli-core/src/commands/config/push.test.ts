import { test, expect, describe, beforeEach, afterEach, mock } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { configPatch, configPut, printDiff, hasConfigChanges } from "./push.ts";
import { testRoot } from "../../test/lib/test-root.ts";

const MOCK_RESPONSE = {
  session: { lifetime: 3600 },
  sign_up: { mode: "public" },
};

// "Current" config returned by GET /config before push.
// Differs from payloads so hasConfigChanges detects changes.
const CURRENT_CONFIG = {
  session: { lifetime: 604800 },
  sign_up: { mode: "restricted" },
};

const HUMAN_NO_PROMPT = { isHuman: () => false, isAgent: () => true } as const;

type Ctx = {
  appId: string;
  appLabel: string;
  instanceId: string;
  instanceLabel: string;
};

interface DepsOpts {
  ctx?: Ctx;
  current?: Record<string, unknown>;
  resolveError?: Error;
  fetchCurrentError?: Error;
  pushError?: Error;
  pushResponse?: Record<string, unknown>;
  human?: boolean;
  confirmResponse?: boolean;
}

interface PushCapture {
  put: Array<{
    appId: string;
    instanceId: string;
    config: Record<string, unknown>;
    options?: { destructive?: boolean };
  }>;
  patch: Array<{
    appId: string;
    instanceId: string;
    config: Record<string, unknown>;
    options?: { destructive?: boolean };
  }>;
}

function depsFor(opts: DepsOpts = {}) {
  const capture: PushCapture = { put: [], patch: [] };
  const {
    ctx = {
      appId: "app_1",
      appLabel: "app_1",
      instanceId: "ins_dev",
      instanceLabel: "development",
    },
    current = CURRENT_CONFIG as Record<string, unknown>,
    resolveError,
    fetchCurrentError,
    pushError,
    pushResponse = MOCK_RESPONSE as Record<string, unknown>,
    human = false,
    confirmResponse = true,
  } = opts;

  const deps = testRoot({
    mode: human ? { isHuman: () => true, isAgent: () => false } : HUMAN_NO_PROMPT,
    prompts: {
      confirm: async () => confirmResponse,
    },
    configStore: {
      resolveAppContext: async () => {
        if (resolveError) throw resolveError;
        return ctx;
      },
    },
    plapi: {
      fetchInstanceConfig: async () => {
        if (fetchCurrentError) throw fetchCurrentError;
        // Clone so the implementation's `delete config_version` doesn't mutate
        // the shared fixture between tests.
        return JSON.parse(JSON.stringify(current));
      },
      putInstanceConfig: async (appId, instanceId, config, options) => {
        capture.put.push({ appId, instanceId, config, options });
        if (pushError) throw pushError;
        return pushResponse;
      },
      patchInstanceConfig: async (appId, instanceId, config, options) => {
        capture.patch.push({ appId, instanceId, config, options });
        if (pushError) throw pushError;
        return pushResponse;
      },
    },
  });

  return { deps, capture };
}

describe("config push", () => {
  let tempDir: string;

  // Helper to read the captured call args off the testRoot's log.info spy.
  function logInfoCalls(deps: { log: { info: unknown } }): string[] {
    return ((deps.log.info as ReturnType<typeof mock>).mock.calls as unknown[][]).map((c) =>
      String(c[0] ?? ""),
    );
  }

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "clerk-config-push-test-"));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  // --- Shared error cases ---

  test("errors when no profile is linked", async () => {
    const { deps } = depsFor({
      resolveError: new Error("No Clerk project linked to this directory."),
    });
    await expect(configPatch(deps, { json: '{"a":1}' })).rejects.toThrow("No Clerk project linked");
  });

  test("errors when CLERK_PLATFORM_API_KEY is missing", async () => {
    const { deps } = depsFor({
      fetchCurrentError: new Error("Not authenticated. Run `clerk auth login`."),
    });
    await expect(configPatch(deps, { json: '{"a":1}', yes: true })).rejects.toThrow(
      "Not authenticated",
    );
  });

  test("errors when no input source is provided", async () => {
    const { deps } = depsFor();
    // Without --file or --json, falls through to stdin which yields empty input
    await expect(configPatch(deps, {})).rejects.toThrow("No input");
  });

  test("errors on invalid JSON input", async () => {
    const { deps } = depsFor();
    await expect(configPatch(deps, { json: "not-json" })).rejects.toThrow("Invalid JSON");
  });

  test("errors when JSON is an array", async () => {
    const { deps } = depsFor();
    await expect(configPatch(deps, { json: "[1,2,3]" })).rejects.toThrow(
      "Config must be a JSON object",
    );
  });

  test("errors when --file points to nonexistent file", async () => {
    const { deps } = depsFor();
    await expect(configPatch(deps, { file: "/tmp/does-not-exist.json" })).rejects.toThrow(
      "File not found",
    );
  });

  // --- PATCH happy paths ---

  test("patch sends PATCH method with --json input", async () => {
    const { deps, capture } = depsFor();

    await configPatch(deps, { json: '{"session":{"lifetime":3600}}', yes: true });
    expect(capture.patch).toHaveLength(1);
    expect(capture.patch[0]!.config).toEqual({ session: { lifetime: 3600 } });
    expect(capture.put).toHaveLength(0);
  });

  test("patch supports --app without a linked profile", async () => {
    const { deps, capture } = depsFor();

    await configPatch(deps, {
      app: "app_1",
      json: '{"session":{"lifetime":3600}}',
      yes: true,
    });
    expect(capture.patch[0]!.appId).toBe("app_1");
    expect(capture.patch[0]!.instanceId).toBe("ins_dev");
  });

  test("patch reads config from --file", async () => {
    const { deps, capture } = depsFor();
    const configFile = join(tempDir, "input.json");
    await Bun.write(configFile, JSON.stringify({ session: { lifetime: 7200 } }));

    await configPatch(deps, { file: configFile, yes: true });
    expect(capture.patch[0]!.config).toEqual({ session: { lifetime: 7200 } });
  });

  test("patch prints returned config to stdout", async () => {
    const { deps } = depsFor();
    await configPatch(deps, { json: '{"session":{"lifetime":3600}}', yes: true });
    expect(deps.log.data).toHaveBeenCalledWith(JSON.stringify(MOCK_RESPONSE, null, 2));
  });

  test("patch shows 'Updating' label", async () => {
    const { deps } = depsFor();
    await configPatch(deps, { json: '{"session":{"lifetime":3600}}', yes: true });
    expect(
      logInfoCalls(deps).some((m) => m.includes("Updating config on app_1 (development)")),
    ).toBe(true);
  });

  // --- PUT happy paths ---

  test("put sends PUT method", async () => {
    const { deps, capture } = depsFor();

    await configPut(deps, { json: '{"session":{"lifetime":3600}}', yes: true });
    expect(capture.put).toHaveLength(1);
    expect(capture.patch).toHaveLength(0);
  });

  test("put shows 'Replacing' label", async () => {
    const { deps } = depsFor();
    await configPut(deps, { json: '{"session":{"lifetime":3600}}', yes: true });
    expect(
      logInfoCalls(deps).some((m) => m.includes("Replacing config on app_1 (development)")),
    ).toBe(true);
  });

  // --- config_version stripping ---

  test("put strips config_version from payload before sending", async () => {
    const { deps, capture } = depsFor();
    await configPut(deps, {
      json: '{"config_version":42,"session":{"lifetime":3600}}',
      yes: true,
    });
    expect(capture.put[0]!.config).toEqual({ session: { lifetime: 3600 } });
  });

  test("patch strips config_version from payload before sending", async () => {
    const { deps, capture } = depsFor();
    await configPatch(deps, {
      json: '{"config_version":42,"session":{"lifetime":3600}}',
      yes: true,
    });
    expect(capture.patch[0]!.config).toEqual({ session: { lifetime: 3600 } });
  });

  // --- --destructive flag ---

  test("patch sends destructive flag when --destructive is set", async () => {
    const { deps, capture } = depsFor();
    await configPatch(deps, {
      json: '{"session":null}',
      yes: true,
      destructive: true,
    });
    expect(capture.patch[0]!.options).toEqual({ destructive: true });
  });

  test("put sends destructive flag when --destructive is set", async () => {
    const { deps, capture } = depsFor();
    await configPut(deps, {
      json: '{"session":null}',
      yes: true,
      destructive: true,
    });
    expect(capture.put[0]!.options).toEqual({ destructive: true });
  });

  test("does not send destructive flag by default", async () => {
    const { deps, capture } = depsFor();
    await configPatch(deps, { json: '{"session":{"lifetime":3600}}', yes: true });
    expect(capture.patch[0]!.options).toEqual({ destructive: undefined });
  });

  // --- No-op when unchanged ---

  test("patch skips API call when payload matches current config", async () => {
    const { deps, capture } = depsFor();
    // Send a payload that matches the current config for the patched key
    await configPatch(deps, { json: '{"session":{"lifetime":604800}}', yes: true });
    expect(capture.patch).toHaveLength(0);
    expect(deps.log.info).toHaveBeenCalledWith("No changes detected");
  });

  test("put skips API call when payload matches current config", async () => {
    const { deps, capture } = depsFor();
    await configPut(deps, { json: JSON.stringify(CURRENT_CONFIG), yes: true });
    expect(capture.put).toHaveLength(0);
    expect(deps.log.info).toHaveBeenCalledWith("No changes detected");
  });

  test("put detects no changes when current config has config_version (pull→put roundtrip)", async () => {
    const configWithVersion = { ...CURRENT_CONFIG, config_version: 42 };
    const { deps, capture } = depsFor({ current: configWithVersion });
    // Simulate pull→put: payload includes config_version from the pull output
    await configPut(deps, { json: JSON.stringify(configWithVersion), yes: true });
    expect(capture.put).toHaveLength(0);
    expect(deps.log.info).toHaveBeenCalledWith("No changes detected");
  });

  // --- Instance targeting ---

  test("targets development instance by default", async () => {
    const { deps, capture } = depsFor();
    await configPatch(deps, { json: '{"a":1}', yes: true });
    expect(capture.patch[0]!.instanceId).toBe("ins_dev");
  });

  test("--instance prod targets production instance", async () => {
    const { deps, capture } = depsFor({
      ctx: {
        appId: "app_1",
        appLabel: "app_1",
        instanceId: "ins_prod",
        instanceLabel: "production",
      },
    });
    await configPatch(deps, { json: '{"a":1}', instance: "prod", yes: true });
    expect(capture.patch[0]!.instanceId).toBe("ins_prod");
  });

  test("--instance with literal ID passes through", async () => {
    const { deps, capture } = depsFor({
      ctx: {
        appId: "app_1",
        appLabel: "app_1",
        instanceId: "ins_custom_123",
        instanceLabel: "ins_custom_123",
      },
    });
    await configPut(deps, {
      json: '{"a":1}',
      instance: "ins_custom_123",
      yes: true,
    });
    expect(capture.put[0]!.instanceId).toBe("ins_custom_123");
  });

  // --- Dry run ---

  test("dry-run prints payload without calling API", async () => {
    const { deps, capture } = depsFor();
    await configPatch(deps, {
      json: '{"session":{"lifetime":3600}}',
      dryRun: true,
    });
    expect(capture.patch).toHaveLength(0);
    expect(deps.plapi.fetchInstanceConfig).not.toHaveBeenCalled();
    expect(logInfoCalls(deps).some((m) => m.includes("[dry-run]"))).toBe(true);
    expect(deps.log.data).toHaveBeenCalledWith(
      JSON.stringify({ session: { lifetime: 3600 } }, null, 2),
    );
  });

  test("dry-run for put shows PUT method", async () => {
    const { deps } = depsFor();
    await configPut(deps, { json: '{"a":1}', dryRun: true });
    expect(logInfoCalls(deps).some((m) => m.includes("[dry-run] Would PUT"))).toBe(true);
  });

  // --- API error handling ---

  test("handles API errors gracefully", async () => {
    const { deps } = depsFor({ pushError: new Error("API error: Bad Request") });
    await expect(configPatch(deps, { json: '{"a":1}', yes: true })).rejects.toThrow("API error");
  });

  test("shows success message after push", async () => {
    const { deps } = depsFor();
    await configPatch(deps, { json: '{"a":1}', yes: true });
    expect(deps.log.info).toHaveBeenCalledWith("Config pushed successfully");
  });

  // --- --json takes priority over --file ---

  test("--json takes priority over --file", async () => {
    const { deps, capture } = depsFor();
    const configFile = join(tempDir, "should-not-read.json");
    await Bun.write(configFile, JSON.stringify({ from: "file" }));

    await configPatch(deps, {
      json: '{"from":"json"}',
      file: configFile,
      yes: true,
    });
    expect(capture.patch[0]!.config).toEqual({ from: "json" });
  });

  // --- Confirmation prompt ---

  test("human mode prompts for confirmation and aborts on no", async () => {
    const { deps, capture } = depsFor({ human: true, confirmResponse: false });
    await expect(
      configPatch(deps, { json: '{"session":{"lifetime":3600}}' }),
    ).rejects.toBeDefined();
    expect(capture.patch).toHaveLength(0);
    expect(deps.prompts.confirm).toHaveBeenCalled();
  });

  test("--yes skips confirmation prompt", async () => {
    const { deps, capture } = depsFor({ human: true });
    await configPatch(deps, { json: '{"session":{"lifetime":3600}}', yes: true });
    expect(capture.patch).toHaveLength(1);
    expect(deps.prompts.confirm).not.toHaveBeenCalled();
  });
});

describe("printDiff", () => {
  function captureDiff() {
    const lines: string[] = [];
    const deps = {
      log: {
        info: (msg: string) => {
          // Strip ANSI codes for easier assertion.
          // eslint-disable-next-line no-control-regex
          lines.push(msg.replace(/\x1b\[[0-9;]*m/g, ""));
        },
      },
    };
    return { deps, lines };
  }

  test("patch mode: shows only changed leaf values", () => {
    const { deps, lines } = captureDiff();
    const current = { session: { lifetime: 604800, cookie: "__session" } };
    const patch = { session: { lifetime: 3600 } };

    printDiff(deps, current, patch, true);

    expect(lines).toEqual(["  session:", "    lifetime:", "      - 604800", "      + 3600"]);
  });

  test("patch mode: skips unchanged keys", () => {
    const { deps, lines } = captureDiff();
    const current = { session: { lifetime: 3600 }, sign_up: { mode: "public" } };
    const patch = { session: { lifetime: 3600 } };

    printDiff(deps, current, patch, true);

    expect(lines).toEqual([]);
  });

  test("patch mode: shows new keys being added", () => {
    const { deps, lines } = captureDiff();
    const current = {};
    const patch = { session: { lifetime: 3600 } };

    printDiff(deps, current, patch, true);

    expect(lines).toEqual(["  session:", '    + {"lifetime":3600}']);
  });

  test("patch mode: ignores keys not in patch", () => {
    const { deps, lines } = captureDiff();
    const current = { session: { lifetime: 604800 }, sign_up: { mode: "public" } };
    const patch = { session: { lifetime: 3600 } };

    printDiff(deps, current, patch, true);

    // sign_up should not appear
    expect(lines.some((l) => l.includes("sign_up"))).toBe(false);
  });

  test("put mode: shows removed keys", () => {
    const { deps, lines } = captureDiff();
    const current = { session: { lifetime: 604800 }, sign_up: { mode: "public" } };
    const payload = { session: { lifetime: 604800 } };

    printDiff(deps, current, payload, false);

    // session is unchanged, sign_up is being removed
    expect(lines.some((l) => l.includes("sign_up"))).toBe(true);
    expect(lines.some((l) => l.includes("- {"))).toBe(true);
  });

  test("put mode: shows both old and new for changed values", () => {
    const { deps, lines } = captureDiff();
    const current = { session: { lifetime: 604800 } };
    const payload = { session: { lifetime: 3600 } };

    printDiff(deps, current, payload, false);

    expect(lines).toContainEqual(expect.stringContaining("- 604800"));
    expect(lines).toContainEqual(expect.stringContaining("+ 3600"));
  });

  test("handles deeply nested changes", () => {
    const { deps, lines } = captureDiff();
    const current = { a: { b: { c: { d: 1 } } } };
    const patch = { a: { b: { c: { d: 2 } } } };

    printDiff(deps, current, patch, true);

    expect(lines).toEqual(["  a:", "    b.c.d:", "      - 1", "      + 2"]);
  });

  test("handles array value changes", () => {
    const { deps, lines } = captureDiff();
    const current = { allowed: { origins: ["a.com", "b.com"] } };
    const patch = { allowed: { origins: ["a.com", "c.com"] } };

    printDiff(deps, current, patch, true);

    expect(lines).toContainEqual(expect.stringContaining('- ["a.com","b.com"]'));
    expect(lines).toContainEqual(expect.stringContaining('+ ["a.com","c.com"]'));
  });
});

describe("hasConfigChanges", () => {
  test("patch mode: no change when partial payload matches nested values", () => {
    const current = { session: { lifetime: 604800, cookie: "__session" } };
    const payload = { session: { lifetime: 604800 } };

    expect(hasConfigChanges(current, payload, true)).toBe(false);
  });

  test("patch mode: detects change in nested value", () => {
    const current = { session: { lifetime: 604800, cookie: "__session" } };
    const payload = { session: { lifetime: 3600 } };

    expect(hasConfigChanges(current, payload, true)).toBe(true);
  });

  test("put mode: detects removal of keys not in payload", () => {
    const current = { session: { lifetime: 604800 }, sign_up: { mode: "public" } };
    const payload = { session: { lifetime: 604800 } };

    expect(hasConfigChanges(current, payload, false)).toBe(true);
  });

  test("put mode: no change when both sides match", () => {
    const current = { session: { lifetime: 604800 } };
    const payload = { session: { lifetime: 604800 } };

    expect(hasConfigChanges(current, payload, false)).toBe(false);
  });
});
