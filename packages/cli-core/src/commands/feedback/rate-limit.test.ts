import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  FEEDBACK_DAILY_LIMIT,
  FEEDBACK_SENDS_FILE_NAME,
  FEEDBACK_WINDOW_MS,
} from "../../lib/constants.ts";
import {
  _setFeedbackCacheDir,
  checkFeedbackRateLimit,
  readRecentFeedbackSends,
  recordFeedbackSend,
  type FeedbackSend,
} from "./rate-limit.ts";

let cacheDir: string;
beforeEach(async () => {
  cacheDir = await mkdtemp(join(tmpdir(), "clerk-feedback-rate-"));
  _setFeedbackCacheDir(cacheDir);
});
afterEach(async () => {
  _setFeedbackCacheDir(undefined);
  await rm(cacheDir, { recursive: true, force: true });
});

const NOW = 1_800_000_000_000;
const send = (
  sentAt: number,
  command: string | null = null,
  errorCode: string | null = null,
): FeedbackSend => ({ sentAt, command, errorCode });
const sends = (count: number): FeedbackSend[] =>
  Array.from({ length: count }, (_, i) => send(NOW - i * 1000));

describe("checkFeedbackRateLimit", () => {
  test("allows a report when nothing was sent recently", () => {
    expect(checkFeedbackRateLimit([], { command: "users list", errorCode: "x" })).toEqual({
      allowed: true,
    });
  });

  test("the daily limit is 50 reports", () => {
    expect(FEEDBACK_DAILY_LIMIT).toBe(50);
  });

  test("refuses at the daily limit and allows one below it", () => {
    const report = { command: null, errorCode: null };
    expect(checkFeedbackRateLimit(sends(FEEDBACK_DAILY_LIMIT - 1), report)).toEqual({
      allowed: true,
    });
    expect(checkFeedbackRateLimit(sends(FEEDBACK_DAILY_LIMIT), report)).toEqual({
      allowed: false,
      reason: "daily_limit",
    });
  });

  // The repeat check applies only when both fields are present on both sides,
  // so a report about a command that merely did the wrong thing is never
  // collapsed with another.
  test.each([
    ["same command and code", "users list", "not_linked", false],
    ["same command, different code", "users list", "api_error", true],
    ["different command, same code", "apps list", "not_linked", true],
    ["no command on the new report", null, "not_linked", true],
    ["no code on the new report", "users list", null, true],
  ])("%s → allowed %p", (_label, command, errorCode, allowed) => {
    const recent = [send(NOW, "users list", "not_linked")];
    const verdict = checkFeedbackRateLimit(recent, { command, errorCode });
    expect(verdict.allowed).toBe(allowed);
    if (!verdict.allowed) expect(verdict.reason).toBe("repeat");
  });

  // A send the endpoint refused (a 4xx) was not stored, so it never blocks a
  // retry about the same command and code; it still counts toward the
  // daily total.
  test("a send marked daily-total-only never counts as a repeat", () => {
    const recent = [{ ...send(NOW, "users list", "not_linked"), dailyTotalOnly: true }];
    expect(
      checkFeedbackRateLimit(recent, { command: "users list", errorCode: "not_linked" }),
    ).toEqual({ allowed: true });
  });

  test("a send marked daily-total-only counts toward the daily limit", () => {
    const recent = [...sends(FEEDBACK_DAILY_LIMIT - 1), { ...send(NOW - 1), dailyTotalOnly: true }];
    expect(checkFeedbackRateLimit(recent, { command: null, errorCode: null })).toEqual({
      allowed: false,
      reason: "daily_limit",
    });
  });

  test("a recorded send without a code never counts as a repeat", () => {
    const recent = [send(NOW, "users list", null)];
    expect(
      checkFeedbackRateLimit(recent, { command: "users list", errorCode: "not_linked" }),
    ).toEqual({ allowed: true });
  });
});

describe("the sends file", () => {
  const file = () => join(cacheDir, FEEDBACK_SENDS_FILE_NAME);

  test("a missing file is empty", async () => {
    expect(await readRecentFeedbackSends(NOW)).toEqual([]);
  });

  test("an unreadable file is empty", async () => {
    await Bun.write(file(), "{not json");
    expect(await readRecentFeedbackSends(NOW)).toEqual([]);
  });

  test("records a send and reads it back", async () => {
    const entry = send(NOW, "users list", "not_linked");
    await recordFeedbackSend(entry);
    expect(await readRecentFeedbackSends(NOW)).toEqual([entry]);
    // Appends: a second send keeps the first.
    await recordFeedbackSend(send(NOW + 1));
    expect(await readRecentFeedbackSends(NOW + 1)).toHaveLength(2);
  });

  test("keeps the daily-total-only mark when read back", async () => {
    const entry = { ...send(NOW, "users list", "not_linked"), dailyTotalOnly: true };
    await recordFeedbackSend(entry);
    expect(await readRecentFeedbackSends(NOW)).toEqual([entry]);
  });

  test("drops an entry whose daily-total-only mark is not a boolean", async () => {
    await Bun.write(
      file(),
      JSON.stringify({ sends: [{ ...send(NOW), dailyTotalOnly: "yes" }, send(NOW - 1)] }),
    );
    expect(await readRecentFeedbackSends(NOW)).toEqual([send(NOW - 1)]);
  });

  test("drops sends outside the window and malformed entries", async () => {
    await Bun.write(
      file(),
      JSON.stringify({
        sends: [
          send(NOW - FEEDBACK_WINDOW_MS), // exactly one window old: out
          send(NOW - FEEDBACK_WINDOW_MS + 1), // just inside
          { sentAt: "yesterday" },
          "garbage",
        ],
      }),
    );
    expect(await readRecentFeedbackSends(NOW)).toEqual([send(NOW - FEEDBACK_WINDOW_MS + 1)]);
  });

  // A clock that jumped backwards makes recent sends look like the future.
  // They still count, and the window is measured from the newest send, so the
  // cap is not wiped by setting the clock back.
  test("a send dated after now still counts, and the window runs from the newest send", async () => {
    const later = NOW + 60 * 60 * 1000;
    await Bun.write(
      file(),
      JSON.stringify({
        sends: [send(later - FEEDBACK_WINDOW_MS), send(later - 1000), send(later)],
      }),
    );
    expect(await readRecentFeedbackSends(NOW)).toEqual([send(later - 1000), send(later)]);
  });

  // A send recorded while the clock ran far ahead must not block reports
  // until real time catches up: a record more than one window ahead of now is
  // ignored, both as a send and as the end of the window.
  test("a send dated more than one window ahead of now is ignored", async () => {
    const yearAhead = NOW + 365 * 24 * 60 * 60 * 1000;
    await Bun.write(
      file(),
      JSON.stringify({
        sends: [send(NOW - 1000, "users list", "boom"), send(yearAhead, "users list", "boom")],
      }),
    );
    const recent = await readRecentFeedbackSends(NOW);
    expect(recent).toEqual([send(NOW - 1000, "users list", "boom")]);
  });

  test("a full limit of sends dated a year ahead does not block a report now", async () => {
    const yearAhead = NOW + 365 * 24 * 60 * 60 * 1000;
    await Bun.write(
      file(),
      JSON.stringify({
        sends: Array.from({ length: FEEDBACK_DAILY_LIMIT }, (_, i) =>
          send(yearAhead + i, "users list", "boom"),
        ),
      }),
    );
    expect(
      checkFeedbackRateLimit(await readRecentFeedbackSends(NOW), {
        command: "users list",
        errorCode: "boom",
      }),
    ).toEqual({ allowed: true });
  });

  test("recording after a backward clock jump keeps the sends recorded before it", async () => {
    const later = NOW + 60 * 60 * 1000;
    await recordFeedbackSend(send(later));
    await recordFeedbackSend(send(NOW));
    expect(await readRecentFeedbackSends(NOW)).toEqual([send(NOW), send(later)]);
  });

  test("recording prunes what is outside the window", async () => {
    await Bun.write(file(), JSON.stringify({ sends: [send(NOW - FEEDBACK_WINDOW_MS - 1)] }));
    await recordFeedbackSend(send(NOW));
    expect(await readRecentFeedbackSends(NOW)).toEqual([send(NOW)]);
  });
});
