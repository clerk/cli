import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import {
  log,
  type CapturedLogs,
  withCapturedLogs,
  setLogLevel,
  getLogLevel,
  pushPrefix,
  popPrefix,
  setPrefixTone,
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

let savedLevel: LogLevel;

beforeEach(() => {
  savedLevel = getLogLevel();
});

afterEach(() => {
  setLogLevel(savedLevel);
});

describe("withCapturedLogs", () => {
  test("isolates interleaved async logging", async () => {
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

  test("restores the parent capture after nested scopes", async () => {
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
});

describe("log levels", () => {
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
});

describe("withTag", () => {
  test("prefixes messages with dim tag", () => {
    const cap = createCapture();
    const tagged = log.withTag("api");

    withCapturedLogs(cap, () => {
      tagged.info("request sent");
    });

    expect(cap.stderr.length).toBe(1);
    expect(cap.stderr[0]).toContain("[api]");
    expect(cap.stderr[0]).toContain("request sent");
  });

  test("nested tags combine with colon", () => {
    const cap = createCapture();
    const tagged = log.withTag("http").withTag("request");

    withCapturedLogs(cap, () => {
      tagged.info("GET /");
    });

    expect(cap.stderr[0]).toContain("[http:request]");
    expect(cap.stderr[0]).toContain("GET /");
  });

  test("respects log level", () => {
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

  test("data goes to stdout without tag prefix", () => {
    const cap = createCapture();
    const tagged = log.withTag("api");

    withCapturedLogs(cap, () => {
      tagged.data("raw output");
    });

    expect(cap.stdout).toEqual(["raw output"]);
  });

  test("preserves outer color after dim tag", () => {
    const cap = createCapture();
    const tagged = log.withTag("api");

    withCapturedLogs(cap, () => {
      tagged.error("broken");
    });

    expect(cap.stderr).toHaveLength(1);
    const [output] = cap.stderr as [string];
    const tagEnd = output.indexOf("]");
    const afterTagBeforeMessage = output.slice(tagEnd + 1, output.indexOf("broken"));
    expect(afterTagBeforeMessage).not.toContain("\x1b[0m");
    expect(output).toContain("\x1b[22m");
  });
});

describe("inline highlighting", () => {
  test("backtick spans are highlighted in cyan", () => {
    const cap = createCapture();

    withCapturedLogs(cap, () => {
      log.info("Run `clerk link` to continue");
    });

    expect(cap.stderr.length).toBe(1);
    expect(cap.stderr[0]).toContain("\x1b[36m");
    expect(cap.stderr[0]).toContain("clerk link");
  });

  test("does not use full ANSI reset that breaks outer styles", () => {
    const cap = createCapture();

    withCapturedLogs(cap, () => {
      log.info("Run `clerk link` then check");
    });

    expect(cap.stderr).toHaveLength(1);
    const [output] = cap.stderr as [string];
    const beforeBacktick = output.indexOf("\x1b[36m");
    const afterBacktick = output.indexOf("clerk link") + "clerk link".length;
    const highlightRegion = output.slice(beforeBacktick, afterBacktick + 10);
    expect(highlightRegion).not.toContain("\x1b[0m");
  });
});

describe("blank", () => {
  test("includes pipe prefix when inside intro/outro flow", () => {
    const cap = createCapture();

    withCapturedLogs(cap, () => {
      pushPrefix();
      log.blank();
      popPrefix();
    });

    expect(cap.stderr.length).toBe(1);
    expect(cap.stderr[0]).toContain("│");
  });

  test("colors pipe prefix from the active gutter tone", () => {
    const cap = createCapture();

    withCapturedLogs(cap, () => {
      pushPrefix("active");
      log.info("working");
      setPrefixTone("error");
      log.info("needs attention");
      setPrefixTone("cancel");
      log.info("cancelled");
      popPrefix();
    });

    expect(cap.stderr).toHaveLength(3);
    expect(cap.stderr[0]).toContain("\x1b[36m│");
    expect(cap.stderr[1]).toContain("\x1b[33m│");
    expect(cap.stderr[2]).toContain("\x1b[31m│");
  });
});

describe("raw", () => {
  test("is never throttled for duplicate messages", () => {
    const cap = createCapture();
    const payload = JSON.stringify({
      error: { code: "auth_required", message: "Not authenticated" },
    });

    withCapturedLogs(cap, () => {
      log.raw(payload);
      log.raw(payload);
      log.raw(payload);
    });

    expect(cap.stderr.length).toBe(3);
    expect(cap.stderr.every((line) => line === payload)).toBe(true);
  });
});
