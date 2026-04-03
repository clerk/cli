import { test, expect } from "bun:test";
import { log, type CapturedLogs, withCapturedLogs } from "./log.ts";

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
