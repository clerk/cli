import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { log, setLogLevel, getLogLevel, pushPrefix, popPrefix, type LogLevel } from "./log.ts";
import { useCaptureLog } from "../test/lib/stubs.ts";
import { setColorEnabled, isColorEnabled } from "./color.ts";

let savedLevel: LogLevel;
let savedColor: boolean;

beforeEach(() => {
  savedLevel = getLogLevel();
  savedColor = isColorEnabled();
  // Tests assert against ANSI escape sequences; force color on regardless of TTY.
  setColorEnabled(true);
});

afterEach(() => {
  setLogLevel(savedLevel);
  setColorEnabled(savedColor);
});

describe("log levels", () => {
  const captured = useCaptureLog();

  test("debug messages are hidden at default info level", () => {
    setLogLevel("info");
    log.debug("should be hidden");
    log.info("should be visible");
    expect(captured.stderr).toEqual(["should be visible"]);
  });

  test("debug messages are shown at debug level", () => {
    setLogLevel("debug");
    log.debug("visible debug");
    expect(captured.stderr.length).toBe(1);
    expect(captured.stderr[0]).toContain("visible debug");
  });

  test("warn level hides info and debug", () => {
    setLogLevel("warn");
    log.debug("hidden");
    log.info("hidden");
    log.warn("visible");
    log.error("visible");
    expect(captured.stderr.length).toBe(2);
  });

  test("silent level hides everything", () => {
    setLogLevel("silent");
    log.error("hidden");
    log.warn("hidden");
    log.info("hidden");
    log.debug("hidden");
    expect(captured.stderr).toEqual([]);
  });

  test("data output is never filtered by log level", () => {
    setLogLevel("silent");
    log.data("always visible");
    expect(captured.stdout).toEqual(["always visible"]);
  });
});

describe("withTag", () => {
  const captured = useCaptureLog();

  test("prefixes messages with dim tag", () => {
    const tagged = log.withTag("api");
    tagged.info("request sent");
    expect(captured.stderr.length).toBe(1);
    expect(captured.stderr[0]).toContain("[api]");
    expect(captured.stderr[0]).toContain("request sent");
  });

  test("nested tags combine with colon", () => {
    const tagged = log.withTag("http").withTag("request");
    tagged.info("GET /");
    expect(captured.stderr[0]).toContain("[http:request]");
    expect(captured.stderr[0]).toContain("GET /");
  });

  test("respects log level", () => {
    setLogLevel("warn");
    const tagged = log.withTag("api");
    tagged.info("hidden");
    tagged.warn("visible");
    expect(captured.stderr.length).toBe(1);
    expect(captured.stderr[0]).toContain("visible");
  });

  test("data goes to stdout without tag prefix", () => {
    const tagged = log.withTag("api");
    tagged.data("raw output");
    expect(captured.stdout).toEqual(["raw output"]);
  });

  test("preserves outer color after dim tag", () => {
    const tagged = log.withTag("api");
    tagged.error("broken");
    expect(captured.stderr).toHaveLength(1);
    const [output] = captured.stderr as [string];
    const tagEnd = output.indexOf("]");
    const afterTagBeforeMessage = output.slice(tagEnd + 1, output.indexOf("broken"));
    expect(afterTagBeforeMessage).not.toContain("\x1b[0m");
    expect(output).toContain("\x1b[22m");
  });
});

describe("inline highlighting", () => {
  const captured = useCaptureLog();

  test("backtick spans are highlighted in cyan", () => {
    log.info("Run `clerk link` to continue");
    expect(captured.stderr.length).toBe(1);
    expect(captured.stderr[0]).toContain("\x1b[36m");
    expect(captured.stderr[0]).toContain("clerk link");
  });

  test("does not use full ANSI reset that breaks outer styles", () => {
    log.info("Run `clerk link` then check");
    expect(captured.stderr).toHaveLength(1);
    const [output] = captured.stderr as [string];
    const beforeBacktick = output.indexOf("\x1b[36m");
    const afterBacktick = output.indexOf("clerk link") + "clerk link".length;
    const highlightRegion = output.slice(beforeBacktick, afterBacktick + 10);
    expect(highlightRegion).not.toContain("\x1b[0m");
  });
});

describe("blank", () => {
  const captured = useCaptureLog();

  test("includes pipe prefix when inside intro/outro flow", () => {
    pushPrefix();
    log.blank();
    popPrefix();
    expect(captured.stderr.length).toBe(1);
    expect(captured.stderr[0]).toContain("│");
  });
});

describe("raw", () => {
  const captured = useCaptureLog();

  test("is never throttled for duplicate messages", () => {
    const payload = JSON.stringify({
      error: { code: "auth_required", message: "Not authenticated" },
    });
    log.raw(payload);
    log.raw(payload);
    log.raw(payload);
    expect(captured.stderr.length).toBe(3);
    expect(captured.stderr.every((line) => line === payload)).toBe(true);
  });
});
