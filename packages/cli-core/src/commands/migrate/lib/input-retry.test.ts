/**
 * `withInputRetry` — the loop that puts a credential prompt back up when the
 * far end rejects what it was given.
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
let cancelPrompt = false;

// Every export of the real module must appear here — a missing one is a link
// error at import time, which takes down the whole file rather than one prompt.
mock.module("../../../lib/prompts.ts", () => ({
  password: async () => {
    if (cancelPrompt) throw new UserAbortError();
    return answers.shift() ?? "";
  },
  text: async () => answers.shift() ?? "",
  confirm: async () => true,
  multiselect: async () => [],
  select: async () => "",
  editor: async () => "{}",
  note: () => {},
}));

const { withInputRetry } = await import("./input-retry.ts");
const { promptDbUrl } = await import("../export/db-options.ts");

const captured = useCaptureLog();

const CONFIG = {
  platform: "authjs",
  envVar: "AUTHJS_DB_URL",
  prompt: "Auth.js database connection string",
} as const;

const FIRST = "libsql://typo.turso.io?authToken=t";
const SECOND = "libsql://right.turso.io?authToken=t";

const rejected = () => new CliError("Could not reach it", { code: ERROR_CODE.USAGE_ERROR });

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
  cancelPrompt = false;
});

describe("withInputRetry", () => {
  test("returns the first result without prompting when the work succeeds", async () => {
    const seen: string[] = [];

    const { value, input } = await withInputRetry(
      FIRST,
      () => promptDbUrl(CONFIG),
      (url: string) => {
        seen.push(url);
        return Promise.resolve("rows");
      },
    );

    expect(value).toBe("rows");
    expect(input).toBe(FIRST);
    expect(seen).toEqual([FIRST]);
  });

  test("asks again after a failure and runs with the new input", async () => {
    answers = [SECOND];
    const seen: string[] = [];

    const { value } = await withInputRetry(
      FIRST,
      () => promptDbUrl(CONFIG),
      (url: string) => {
        seen.push(url);
        if (url === FIRST) throw rejected();
        return Promise.resolve("rows");
      },
    );

    expect(value).toBe("rows");
    expect(seen).toEqual([FIRST, SECOND]);
    // The operator has to be told what was wrong with a string they cannot see.
    expect(captured.err).toContain("Could not reach it");
  });

  // Later steps run against the credential that worked, not the one first tried
  // — a Firebase export reads its project id off the key that Google accepted.
  test("reports the input that finally worked", async () => {
    answers = [SECOND];

    const { input } = await withInputRetry(
      FIRST,
      () => promptDbUrl(CONFIG),
      (url: string) => {
        if (url === FIRST) throw rejected();
        return Promise.resolve("rows");
      },
    );

    expect(input).toBe(SECOND);
  });

  test("keeps asking until an input works", async () => {
    answers = [FIRST, FIRST, SECOND];
    let attempts = 0;

    await withInputRetry(
      FIRST,
      () => promptDbUrl(CONFIG),
      (url: string) => {
        attempts++;
        if (url !== SECOND) throw rejected();
        return Promise.resolve("rows");
      },
    );

    expect(attempts).toBe(4);
  });

  // Cancelling the prompt is an answer: it ends the command rather than looping
  // on a question the operator has already declined.
  test("lets a cancelled prompt out of the loop", async () => {
    cancelPrompt = true;

    await expect(
      withInputRetry(
        FIRST,
        () => promptDbUrl(CONFIG),
        () => {
          throw rejected();
        },
      ),
    ).rejects.toThrow(UserAbortError);
  });

  test("throws without prompting when there is nobody to ask", async () => {
    setMode("agent");
    let attempts = 0;

    await expect(
      withInputRetry(
        FIRST,
        () => promptDbUrl(CONFIG),
        () => {
          attempts++;
          throw rejected();
        },
      ),
    ).rejects.toThrow(CliError);

    expect(attempts).toBe(1);
  });

  // A bug inside the work, or an interrupt, is not a wrong answer to a prompt.
  test("does not retry an error the database layer did not raise", async () => {
    let attempts = 0;

    await expect(
      withInputRetry(
        FIRST,
        () => promptDbUrl(CONFIG),
        () => {
          attempts++;
          throw new TypeError("undefined is not a function");
        },
      ),
    ).rejects.toThrow(TypeError);

    expect(attempts).toBe(1);
  });
});
