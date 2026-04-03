import { test, expect, beforeEach, afterEach } from "bun:test";
import {
  log,
  type CapturedLogs,
  withCapturedLogs,
  setLogLevel,
  getLogLevel,
  type LogLevel,
} from "./log.ts";

function createCapture(): CapturedLogs {
  return { stdout: [], stderr: [] };
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

// ── Async isolation ──────────────────────────────────────────────────────

test("withCapturedLogs isolates interleaved async logging", async () => {
  const first = createCapture();
  const second = createCapture();
  const firstMayFinish = deferred();
  const secondHasStarted = deferred();

  const firstTask = withCapturedLogs(first, async () => {
    log.info("first:start");
    secondHasStarted.resolve();
    await firstMayFinish.promise;
    log.data("first:end");
  });

  const secondTask = withCapturedLogs(second, async () => {
    log.info("second:start");
    await secondHasStarted.promise;
    log.data("second:end");
    firstMayFinish.resolve();
  });

  await Promise.all([firstTask, secondTask]);

  expect(first.stderr).toEqual(["first:start"]);
  expect(first.stdout).toEqual(["first:end"]);
  expect(second.stderr).toEqual(["second:start"]);
  expect(second.stdout).toEqual(["second:end"]);
});

test("withCapturedLogs restores the parent capture after nested scopes", async () => {
  const outer = createCapture();
  const inner = createCapture();

  await withCapturedLogs(outer, async () => {
    log.info("outer:before");
    await withCapturedLogs(inner, async () => {
      log.data("inner:data");
    });
    log.info("outer:after");
  });

  expect(outer.stderr).toEqual(["outer:before", "outer:after"]);
  expect(outer.stdout).toEqual([]);
  expect(inner.stderr).toEqual([]);
  expect(inner.stdout).toEqual(["inner:data"]);
});

// ── Log levels ───────────────────────────────────────────────────────────

let savedLevel: LogLevel;

beforeEach(() => {
  savedLevel = getLogLevel();
});

afterEach(() => {
  setLogLevel(savedLevel);
});

test("debug messages are hidden at default info level", () => {
  const cap = createCapture();
  setLogLevel("info");

  withCapturedLogs(cap, () => {
    log.debug("should be hidden");
    log.info("should be visible");
  });

  expect(cap.stderr).toEqual(["should be visible"]);
});

test("debug messages are shown at debug level", () => {
  const cap = createCapture();
  setLogLevel("debug");

  withCapturedLogs(cap, () => {
    log.debug("visible debug");
  });

  expect(cap.stderr.length).toBe(1);
  expect(cap.stderr[0]).toContain("visible debug");
});

test("warn level hides info and debug", () => {
  const cap = createCapture();
  setLogLevel("warn");

  withCapturedLogs(cap, () => {
    log.debug("hidden");
    log.info("hidden");
    log.warn("visible");
    log.error("visible");
  });

  expect(cap.stderr.length).toBe(2);
});

test("silent level hides everything", () => {
  const cap = createCapture();
  setLogLevel("silent");

  withCapturedLogs(cap, () => {
    log.error("hidden");
    log.warn("hidden");
    log.info("hidden");
    log.debug("hidden");
  });

  expect(cap.stderr).toEqual([]);
});

test("data output is never filtered by log level", () => {
  const cap = createCapture();
  setLogLevel("silent");

  withCapturedLogs(cap, () => {
    log.data("always visible");
  });

  expect(cap.stdout).toEqual(["always visible"]);
});

// ── Tagged loggers ───────────────────────────────────────────────────────

test("withTag prefixes messages with dim tag", () => {
  const cap = createCapture();
  const tagged = log.withTag("api");

  withCapturedLogs(cap, () => {
    tagged.info("request sent");
  });

  expect(cap.stderr.length).toBe(1);
  expect(cap.stderr[0]).toContain("[api]");
  expect(cap.stderr[0]).toContain("request sent");
});

test("nested withTag combines tags with colon", () => {
  const cap = createCapture();
  const tagged = log.withTag("http").withTag("request");

  withCapturedLogs(cap, () => {
    tagged.info("GET /");
  });

  expect(cap.stderr[0]).toContain("[http:request]");
  expect(cap.stderr[0]).toContain("GET /");
});

test("tagged logger respects log level", () => {
  const cap = createCapture();
  setLogLevel("warn");
  const tagged = log.withTag("api");

  withCapturedLogs(cap, () => {
    tagged.info("hidden");
    tagged.warn("visible");
  });

  expect(cap.stderr.length).toBe(1);
  expect(cap.stderr[0]).toContain("visible");
});

test("tagged data goes to stdout without tag prefix", () => {
  const cap = createCapture();
  const tagged = log.withTag("api");

  withCapturedLogs(cap, () => {
    tagged.data("raw output");
  });

  expect(cap.stdout).toEqual(["raw output"]);
});

// ── Inline highlighting ──────────────────────────────────────────────────

test("backtick spans are highlighted in info messages", () => {
  const cap = createCapture();

  withCapturedLogs(cap, () => {
    log.info("Run `clerk link` to continue");
  });

  expect(cap.stderr.length).toBe(1);
  // Should contain ANSI cyan codes around the backtick content
  expect(cap.stderr[0]).toContain("\x1b[36m");
  expect(cap.stderr[0]).toContain("clerk link");
});
