/**
 * Repro for the garbled "Update available" output reported in Slack: the
 * next-steps outro animation parks the cursor on the header line for ~450ms,
 * so anything printed after the command's promise resolves (the postAction
 * update notice) must not run until the animation has finished. If the command
 * resolves early, the notice lands mid-block and overwrites the step lines.
 *
 * Unlike index.test.ts this file deliberately uses the REAL spinner/gradient
 * modules on a forced-interactive TTY so the animation actually runs.
 */
import { test, expect, describe, beforeEach, afterEach, mock } from "bun:test";
import { log } from "../../lib/log.ts";
import { setMode } from "../../mode.ts";
import { useCaptureLog, configStubs, credentialStoreStubs } from "../../test/lib/stubs.ts";

const MOCK_ENVS = ["production", "staging"];
let mockCurrentEnv = "production";

mock.module("../../lib/config.ts", () => ({
  ...configStubs,
}));

mock.module("../../lib/credential-store.ts", () => ({
  ...credentialStoreStubs,
  getToken: async () => "some-token",
}));

mock.module("../../lib/environment.ts", () => ({
  getCurrentEnvName: () => mockCurrentEnv,
  getAvailableEnvs: () => MOCK_ENVS,
  isValidEnv: (name: string) => MOCK_ENVS.includes(name),
  setCurrentEnv: (name: string) => {
    mockCurrentEnv = name;
  },
}));

const { switchEnv } = await import("./index.ts");

const CURSOR_SHOW = "\x1b[?25h";
const NOTICE = "⬆  Update available: 3.0.1 → 3.1.0";

describe("switch-env update-notice race", () => {
  const captured = useCaptureLog();
  const ENV_KEYS = ["CI", "NO_COLOR", "FORCE_COLOR", "COLORTERM"] as const;
  let savedTTY: boolean | undefined;
  let savedEnv: Record<string, string | undefined>;

  beforeEach(() => {
    setMode("human"); // the runner has no TTY, but the bug only shows in human mode
    mockCurrentEnv = "production";
    savedTTY = process.stderr.isTTY;
    savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
    Object.defineProperty(process.stderr, "isTTY", { value: true, configurable: true });
    for (const k of ENV_KEYS) delete process.env[k];
    process.env.COLORTERM = "truecolor";
  });

  afterEach(() => {
    Object.defineProperty(process.stderr, "isTTY", { value: savedTTY, configurable: true });
    for (const k of ENV_KEYS) {
      if (savedEnv[k] == null) delete process.env[k];
      else process.env[k] = savedEnv[k];
    }
  });

  test("output printed after the command resolves lands below the finished animation", async () => {
    await switchEnv("staging");
    // The postAction hook prints the update notice as soon as the action's
    // promise resolves — reproduce that exact ordering.
    log.warn(NOTICE);
    // Drain any animation frames still in flight so the buffer is complete
    // (and so a buggy run doesn't leak writes into the next test).
    await Bun.sleep(700);

    const err = captured.err;
    const cursorRestoredAt = err.lastIndexOf(CURSOR_SHOW);
    const noticeAt = err.indexOf(NOTICE);
    expect(cursorRestoredAt).toBeGreaterThanOrEqual(0);
    expect(noticeAt).toBeGreaterThan(cursorRestoredAt);
  }, 10_000);
});
