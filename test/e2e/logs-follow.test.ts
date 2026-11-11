/**
 * Live-BAPI test for `clerk logs --follow`. Starts a follow, creates a user
 * once the follow is polling, and waits for that user's `user.created` log to
 * stream out as an NDJSON line. Then stops the follow with Ctrl-C, which must
 * end it by SIGINT (exit 130), as any interrupted operation does.
 *
 * Requires `CLERK_PLATFORM_API_KEY` and `CLERK_CLI_TEST_APP_ID`. Locally,
 * run via `bun run test:e2e:op` so 1Password resolves both in-memory.
 */

import { test, expect, afterAll, beforeAll } from "bun:test";
import { join } from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { createTestUser, deleteTestUser } from "./lib/test-user.ts";

const CLI_PATH = join(import.meta.dir, "../../packages/cli-core/src/cli.ts");
/** Logs reach the API through the event stream pipeline, so allow for its lag. */
const WAIT_FOR_LOG_MS = 60_000;

let APP_ID: string;
let configDir: string;
let userId: string | undefined;

beforeAll(() => {
  const appId = process.env.CLERK_CLI_TEST_APP_ID;
  const platformKey = process.env.CLERK_PLATFORM_API_KEY;
  if (!appId || !platformKey) {
    throw new Error(
      "CLERK_CLI_TEST_APP_ID and CLERK_PLATFORM_API_KEY are required. " +
        "Run via `bun run test:e2e:op` for local 1Password injection.",
    );
  }
  APP_ID = appId;
  configDir = mkdtempSync(join(tmpdir(), "clerk-cli-e2e-logs-follow-"));
});

afterAll(async () => {
  if (userId) await deleteTestUser(userId, configDir, { appId: APP_ID });
  rmSync(configDir, { recursive: true, force: true });
}, 60_000);

/** Reads `stream` to the end, collecting each line in `lines` and handing it to `onLine`. */
async function readLines(
  stream: ReadableStream<Uint8Array>,
  lines: string[],
  onLine: (line: string) => void,
): Promise<void> {
  const decoder = new TextDecoder();
  let buffered = "";
  for await (const chunk of stream) {
    buffered += decoder.decode(chunk, { stream: true });
    let newline = buffered.indexOf("\n");
    while (newline !== -1) {
      const line = buffered.slice(0, newline);
      buffered = buffered.slice(newline + 1);
      lines.push(line);
      onLine(line);
      newline = buffered.indexOf("\n");
    }
  }
}

test("logs --follow --json streams a new user's user.created log and dies by SIGINT on Ctrl-C", async () => {
  const proc = Bun.spawn(
    [
      "bun",
      CLI_PATH,
      "logs",
      "--follow",
      "--json",
      "--verbose",
      "--type",
      "user.created",
      "--limit",
      "1",
      "--app",
      APP_ID,
    ],
    {
      env: {
        ...process.env,
        CLERK_CONFIG_DIR: configDir,
        CLERK_TELEMETRY_DISABLED: "1",
        CLERK_EXPERIMENTAL: "logs",
      },
      stdout: "pipe",
      stderr: "pipe",
    },
  );

  const stdout: string[] = [];
  const stderr: string[] = [];
  let resolvePolling!: () => void;
  const polling = new Promise<void>((resolve) => (resolvePolling = resolve));
  let resolveFound!: (line: string) => void;
  const found = new Promise<string>((resolve) => (resolveFound = resolve));

  // `--verbose` logs every request. The backfill asks for `limit=1`; only a
  // poll asks for the API's maximum, so the first of those means the backfill
  // is done and anything created from here on is new.
  const stderrDone = readLines(proc.stderr, stderr, (line) => {
    if (/bapi: GET \S+\/v1\/logs\?view=flat&limit=500&/.test(line)) resolvePolling();
  });
  const isUserCreated = (line: string) => {
    const entry = JSON.parse(line) as { type?: string; subject?: string };
    return userId !== undefined && entry.type === "user.created" && entry.subject === userId;
  };
  const stdoutDone = readLines(proc.stdout, stdout, (line) => {
    if (isUserCreated(line)) resolveFound(line);
  });

  const timeout = (label: string) =>
    new Promise<never>((_, reject) =>
      setTimeout(
        () =>
          reject(
            new Error(
              `Timed out waiting for ${label}. stderr:\n${stderr.slice(-20).join("\n")}\nstdout:\n${stdout.slice(-5).join("\n")}`,
            ),
          ),
        WAIT_FOR_LOG_MS,
      ),
    );

  try {
    await Promise.race([polling, timeout("the first poll")]);

    const user = await createTestUser(configDir, { appId: APP_ID });
    userId = user.id;
    // The log may have streamed out while `createTestUser` was still returning.
    const early = stdout.find(isUserCreated);
    if (early) resolveFound(early);

    const line = await Promise.race([found, timeout(`the user.created log for ${userId}`)]);
    const entry = JSON.parse(line) as Record<string, unknown>;
    expect(entry.object).toBe("log");
    expect(typeof entry.id).toBe("string");
    expect(typeof entry.event_time).toBe("number");

    // Every stdout line is one log object.
    expect(
      stdout.every((output) => (JSON.parse(output) as { object?: string }).object === "log"),
    ).toBe(true);
    // No log is printed twice. Order isn't checked: a log the pipeline
    // delivers late prints after newer ones.
    const ids = stdout.map((output) => (JSON.parse(output) as { id: string }).id);
    expect(new Set(ids).size).toBe(ids.length);

    proc.kill("SIGINT");
    await proc.exited;
    // Ctrl-C ends an operation by SIGINT, so a wrapping script stops too.
    expect(proc.signalCode).toBe("SIGINT");
  } finally {
    proc.kill();
    await Promise.allSettled([stdoutDone, stderrDone]);
  }
}, 150_000);
