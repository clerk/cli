import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { getMode, setMode, type Mode } from "../../../mode.ts";
import { useCaptureLog } from "../../../test/lib/stubs.ts";
import { formatProgress, formatRemaining, withProgress } from "./progress.ts";

const captured = useCaptureLog();

describe("formatRemaining", () => {
  test.each([
    [9_000, "~9s"],
    [90_000, "~1m 30s"],
    [900_000, "~15m"],
    [500_000, "~8m 20s"],
    [7_500_000, "~2h 5m"],
  ])("%p ms -> %p", (ms, expected) => {
    expect(formatRemaining(ms)).toBe(expected);
  });
});

describe("formatProgress", () => {
  // 10,000 users at ~100 a second, 1% failing: the agreed mockup.
  test("draws an 80-column bar with the report under it", () => {
    const [bar, report] = formatProgress({
      total: 10_000,
      verb: "created",
      counts: { done: 7_500, ok: 7_425, failed: 75 },
      elapsedMs: 75_000,
    });

    expect(bar).toBe(`│  ${"█".repeat(54)}${"░".repeat(18)}  75%`);
    expect([...bar]).toHaveLength(80);
    expect(report).toBe("│  7,500/10,000 users  ·  ✓ 7,425 created  ·  ✗ 75 failed  ·  ~25s left");
  });

  test("shrinks the bar to a narrower terminal", () => {
    const [bar] = formatProgress({
      total: 100,
      verb: "created",
      counts: { done: 50, ok: 50, failed: 0 },
      elapsedMs: 0,
      columns: 60,
    });
    expect([...bar]).toHaveLength(60);
  });

  test.each([
    ["before there is a rate to go on", 1_000, 500],
    ["once every user is done", 10_000, 1_000],
  ])("gives no estimate %s", (_label, elapsedMs, done) => {
    const [, report] = formatProgress({
      total: 1_000,
      verb: "deleted",
      counts: { done, ok: done, failed: 0 },
      elapsedMs,
    });
    expect(report).not.toContain("left");
  });

  // Floored, so 999 of 1,000 never reads as finished.
  test("reads 100% only when every user is done", () => {
    const [bar] = formatProgress({
      total: 1_000,
      verb: "created",
      counts: { done: 999, ok: 999, failed: 0 },
      elapsedMs: 0,
    });
    expect(bar).toEndWith(" 99%");
    expect(bar).toContain("░");
  });
});

describe("withProgress", () => {
  let mode: Mode;
  let isTTY: boolean | undefined;

  beforeEach(() => {
    mode = getMode();
    isTTY = process.stderr.isTTY;
  });

  afterEach(() => {
    setMode(mode);
    process.stderr.isTTY = isTTY as boolean;
  });

  test("prints nothing for an agent", async () => {
    setMode("agent");
    await withProgress({ total: 10, verb: "created" }, async (update) => {
      update({ done: 10, ok: 10, failed: 0 });
    });
    expect(captured.err).toBe("");
  });

  // A log file gets a line per 10%, not a redraw per user.
  test("without a terminal, prints the report at each tenth", async () => {
    setMode("human");
    process.stderr.isTTY = false;

    await withProgress({ total: 100, verb: "created" }, async (update) => {
      for (let done = 1; done <= 100; done++) update({ done, ok: done, failed: 0 });
    });

    const lines = captured.err.split("\n").filter((line) => line.includes("users"));
    // 0% at the start, each tenth from 10% to 100%, and the final state.
    expect(lines).toHaveLength(12);
    expect(lines.at(-1)).toContain("100/100 users");
  });
});
