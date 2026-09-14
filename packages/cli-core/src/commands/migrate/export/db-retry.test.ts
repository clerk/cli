/**
 * `withDbRetry` — the loop that puts the connection-string prompt back up when
 * the database work fails.
 *
 * Its own file because `mock.module` registrations last for the process, and
 * `bun test --parallel` puts several files in each worker — a mocked
 * `prompts.ts` would leak into any file that later lands in the same worker and
 * imports the real one.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { CliError, ERROR_CODE, UserAbortError } from "../../../lib/errors.ts";
import { getMode, setMode, type Mode } from "../../../mode.ts";
import { useCaptureLog } from "../../../test/lib/stubs.ts";

let answers: string[] = [];

// Every export of the real module must appear here — a missing one is a link
// error at import time, which takes down the whole file rather than one prompt.
mock.module("../../../lib/prompts.ts", () => ({
  password: async () => answers.shift() ?? "",
  text: async () => "",
  confirm: async () => true,
  multiselect: async () => [],
  select: async () => "",
  editor: async () => "{}",
  note: () => {},
}));

const { withDbRetry } = await import("./db-options.ts");

const captured = useCaptureLog();

const CONFIG = {
  platform: "authjs",
  envVar: "AUTHJS_DB_URL",
  prompt: "Auth.js database connection string",
} as const;

const FIRST = "libsql://typo.turso.io?authToken=t";
const SECOND = "libsql://right.turso.io?authToken=t";

let originalMode: Mode;

beforeAll(() => {
  originalMode = getMode();
});

afterAll(() => {
  setMode(originalMode);
});

beforeEach(() => {
  setMode("human");
  answers = [];
});

describe("withDbRetry", () => {
  test("returns the first result without prompting when the work succeeds", async () => {
    const seen: string[] = [];

    const result = await withDbRetry(FIRST, CONFIG, (url) => {
      seen.push(url);
      return Promise.resolve("rows");
    });

    expect(result).toBe("rows");
    expect(seen).toEqual([FIRST]);
  });

  test("asks again after a failure and runs with the new connection string", async () => {
    answers = [SECOND];
    const seen: string[] = [];

    const result = await withDbRetry(FIRST, CONFIG, (url) => {
      seen.push(url);
      if (url === FIRST) {
        throw new CliError("Could not reach libsql://***@typo.turso.io", {
          code: ERROR_CODE.USAGE_ERROR,
        });
      }
      return Promise.resolve("rows");
    });

    expect(result).toBe("rows");
    expect(seen).toEqual([FIRST, SECOND]);
    // The operator has to be told what was wrong with the string they cannot see.
    expect(captured.err).toContain("Could not reach");
  });

  test("keeps asking until a connection string works", async () => {
    answers = [FIRST, FIRST, SECOND];
    let attempts = 0;

    await withDbRetry(FIRST, CONFIG, (url) => {
      attempts++;
      if (url !== SECOND) throw new CliError("nope", { code: ERROR_CODE.USAGE_ERROR });
      return Promise.resolve("rows");
    });

    expect(attempts).toBe(4);
  });

  // Cancelling the prompt is an answer: it ends the command rather than
  // looping on a question the operator has already declined.
  test("lets a cancelled prompt out of the loop", async () => {
    mock.module("../../../lib/prompts.ts", () => ({
      password: async () => {
        throw new UserAbortError();
      },
      text: async () => "",
      confirm: async () => true,
      multiselect: async () => [],
      select: async () => "",
      editor: async () => "{}",
      note: () => {},
    }));

    await expect(
      withDbRetry(FIRST, CONFIG, () => {
        throw new CliError("nope", { code: ERROR_CODE.USAGE_ERROR });
      }),
    ).rejects.toThrow(UserAbortError);
  });

  test("throws without prompting when there is nobody to ask", async () => {
    setMode("agent");
    let attempts = 0;

    await expect(
      withDbRetry(FIRST, CONFIG, () => {
        attempts++;
        throw new CliError("nope", { code: ERROR_CODE.USAGE_ERROR });
      }),
    ).rejects.toThrow(CliError);

    expect(attempts).toBe(1);
  });
});
