import { test, expect, afterEach, describe } from "bun:test";

import { getMode, setMode, _resetMode, resolveMode, isHuman, isAgent } from "./mode.ts";

describe("resolveMode", () => {
  // Pure: every input is literal, so the result never depends on the agent or
  // terminal the test suite itself runs under.
  const tty = { forced: undefined, env: {}, isTTY: true };
  const noTty = { forced: undefined, env: {}, isTTY: false };

  test("--mode wins over everything", () => {
    expect(resolveMode({ ...tty, forced: "agent" })).toBe("agent");
    expect(resolveMode({ ...noTty, forced: "human", env: { CODEX_THREAD_ID: "x" } })).toBe("human");
  });

  test("CLERK_MODE wins over detection", () => {
    expect(resolveMode({ ...tty, env: { CLERK_MODE: "agent" } })).toBe("agent");
    expect(resolveMode({ ...noTty, env: { CLERK_MODE: "human" } })).toBe("human");
    expect(resolveMode({ ...tty, env: { CLERK_MODE: "human", CODEX_THREAD_ID: "x" } })).toBe(
      "human",
    );
  });

  test("an unrecognized CLERK_MODE value falls through to detection", () => {
    expect(resolveMode({ ...tty, env: { CLERK_MODE: "bogus" } })).toBe("human");
    expect(resolveMode({ ...noTty, env: { CLERK_MODE: "bogus" } })).toBe("agent");
  });

  test.each(["CODEX_SANDBOX", "CODEX_THREAD_ID", "CODEX_SANDBOX_NETWORK_DISABLED", "CODEX_CI"])(
    "%s marks the run as agent even with a TTY",
    (envVar) => {
      expect(resolveMode({ ...tty, env: { [envVar]: "x" } })).toBe("agent");
    },
  );

  test("Codex is still recognized when it runs inside Claude Code", () => {
    expect(resolveMode({ ...tty, env: { CLAUDECODE: "1", CODEX_THREAD_ID: "x" } })).toBe("agent");
  });

  // Claude Code already runs commands without a TTY; Gemini and Cline let a
  // person type into the terminal, so their markers must not drop prompts.
  test.each(["CLAUDECODE", "CLINE_ACTIVE", "GEMINI_CLI", "CURSOR_AGENT"])(
    "%s alone leaves the TTY decision in place",
    (envVar) => {
      expect(resolveMode({ ...tty, env: { [envVar]: "1" } })).toBe("human");
      expect(resolveMode({ ...noTty, env: { [envVar]: "1" } })).toBe("agent");
    },
  );

  test("a Codex shell-config variable (CODEX_HOME) is not a run marker", () => {
    // Users export CODEX_HOME in their own shell; it says nothing about who is
    // running this command, so it must not drop confirmation prompts.
    expect(resolveMode({ ...tty, env: { CODEX_HOME: "/Users/me/.codex" } })).toBe("human");
  });

  test("an empty Codex marker does not count", () => {
    expect(resolveMode({ ...tty, env: { CODEX_THREAD_ID: "" } })).toBe("human");
  });

  test("with no overrides or markers, a TTY means human and no TTY means agent", () => {
    expect(resolveMode(tty)).toBe("human");
    expect(resolveMode(noTty)).toBe("agent");
  });
});

describe("getMode wiring", () => {
  afterEach(() => {
    _resetMode();
  });

  test("setMode forces the mode and isHuman/isAgent follow it", () => {
    setMode("human");
    expect(getMode()).toBe("human");
    expect(isHuman()).toBe(true);
    expect(isAgent()).toBe(false);

    setMode("agent");
    expect(getMode()).toBe("agent");
    expect(isHuman()).toBe(false);
    expect(isAgent()).toBe(true);
  });

  test("_resetMode clears the forced mode", () => {
    setMode("agent");
    _resetMode();
    // Whatever the ambient result is, it must match an unforced resolve.
    expect(getMode()).toBe(
      resolveMode({ forced: undefined, env: process.env, isTTY: Boolean(process.stdout.isTTY) }),
    );
  });
});
