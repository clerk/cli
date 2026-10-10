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
import { Database } from "bun:sqlite";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CliError, ERROR_CODE, EXIT_CODE, UserAbortError } from "../../../lib/errors.ts";
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
const { promptDbUrl, resolveDbUrl, withDbConnection } = await import("../export/db-options.ts");
const { setAssumeYes } = await import("./assume-yes.ts");

const captured = useCaptureLog();

const CONFIG = {
  platform: "authjs",
  envVar: "AUTHJS_DB_URL",
  prompt: "Auth.js database connection string",
} as const;

const FIRST = "libsql://typo.turso.io?authToken=t";
const SECOND = "libsql://right.turso.io?authToken=t";

const rejected = () =>
  new CliError("Could not reach it", { code: ERROR_CODE.USAGE_ERROR, exitCode: EXIT_CODE.USAGE });

let originalMode: string | undefined;

beforeAll(() => {
  originalMode = process.env.CLERK_MODE;
});

afterAll(() => {
  if (originalMode === undefined) delete process.env.CLERK_MODE;
  else process.env.CLERK_MODE = originalMode;
});

beforeEach(() => {
  process.env.CLERK_MODE = "human";
  setAssumeYes(false);
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
    process.env.CLERK_MODE = "agent";
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

  // `--json` is non-interactive by contract, even when a human is at the TTY.
  test("throws without prompting under --json", async () => {
    let attempts = 0;

    await expect(
      withInputRetry(
        FIRST,
        () => promptDbUrl(CONFIG),
        () => {
          attempts++;
          throw rejected();
        },
        { json: true },
      ),
    ).rejects.toThrow(CliError);

    expect(attempts).toBe(1);
  });

  // `-y` is a human on a TTY who could be asked and said not to. Agent mode
  // cannot reach the prompt at all; this one can and declines to, so it needs
  // its own check rather than riding on the mode assertion above.
  test("throws without prompting when `-y` said not to ask", async () => {
    setAssumeYes(true);
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
  // Another credential would not fix an outage, a 429 or a refused connection.
  test.each([
    ["a refused connection", new CliError("Could not reach x")],
    ["a 503", new CliError("Auth0 returned 503 listing users")],
  ])("does not ask again after %s", async (_label, failure) => {
    let attempts = 0;

    await expect(
      withInputRetry(
        FIRST,
        () => promptDbUrl(CONFIG),
        () => {
          attempts++;
          throw failure;
        },
      ),
    ).rejects.toBe(failure);

    expect(attempts).toBe(1);
  });

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

// Here rather than in `db-exports.test.ts` because the prompt is mocked: a
// missed guard reaches it and returns, where a real prompt would hang the run.
describe("resolveDbUrl", () => {
  test("does not prompt under --json, even with a human at the TTY", async () => {
    answers = [FIRST];

    await expect(resolveDbUrl({ json: true }, CONFIG, {})).rejects.toThrow(/cannot prompt here/);
    expect(answers).toEqual([FIRST]);
  });

  // `-y` is "do not prompt", at a terminal too.
  test("does not prompt under -y, even with a human at the TTY", async () => {
    answers = [FIRST];
    setAssumeYes(true);

    await expect(resolveDbUrl({}, CONFIG, {})).rejects.toThrow(/cannot prompt here/);
    expect(answers).toEqual([FIRST]);
  });
});

// Only the connect proves the connection string. A failure after it is not a
// wrong string, so it is not asked for again, and it is not a usage error.
describe("withDbConnection", () => {
  const sqlite = () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "clerk-dbconn-")), "db.sqlite");
    new Database(file, { create: true }).close();
    return file;
  };

  test("asks again when the connection fails, then runs the work once", async () => {
    answers = [sqlite()];
    let runs = 0;

    const value = await withDbConnection("./no-such-dir/missing.sqlite", CONFIG, {}, async () => {
      runs++;
      return "rows";
    });

    expect(value).toBe("rows");
    expect(runs).toBe(1);
    expect(answers).toEqual([]);
  });

  test("does not ask again when the read fails after connecting, and exits 1", async () => {
    answers = [sqlite()];
    const file = sqlite();

    const error = (await withDbConnection(file, CONFIG, {}, async () => {
      throw new Error("canceling statement due to statement timeout");
    }).catch((caught: unknown) => caught)) as CliError;

    expect(error).toBeInstanceOf(CliError);
    expect(error.exitCode).toBe(EXIT_CODE.GENERAL);
    expect(error.message).toContain("statement timeout");
    expect(answers).toHaveLength(1);
  });
});
