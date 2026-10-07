/**
 * The human-mode half of `migrate import`: the prompts fill in what was not
 * passed, and nothing is written until the operator says yes.
 *
 * Kept in its own file because `mock.module` replaces `prompts.ts` for the whole
 * file; `bun test --parallel` isolates each file, so the mock ends with it.
 * Human mode is set through `CLERK_MODE` rather than `setMode`, because
 * `mode.ts` has no way to clear a forced mode once the file is done.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { listageStubs, useCaptureLog } from "../../test/lib/stubs.ts";

const mockSelect = mock(async () => "clerk" as unknown);
const mockText = mock(async () => "export.json" as unknown);
let confirmAnswer = true;
/** The answer to the reserved-identifiers question, apart from consent. */
let reserveAnswer = true;
/** Every confirmation the run put up, in order — the wording is the assertion. */
let confirmMessages: string[] = [];
let originalMode: string | undefined;

mock.module("../../lib/listage.ts", () => ({
  ...listageStubs,
  select: (...args: unknown[]) => mockSelect(...(args as [])),
}));

// Every export of the real module must appear here — a missing one is a link
// error at import time, which takes down the whole file rather than one prompt.
mock.module("../../lib/prompts.ts", () => ({
  confirm: async ({ message }: { message: string }) => {
    confirmMessages.push(message);
    return message.includes("never verified") ? reserveAnswer : confirmAnswer;
  },
  multiselect: async () => [],
  text: (...args: unknown[]) => mockText(...(args as [])),
  password: async () => "",
  editor: async () => "{}",
}));

const { run } = await import("./run.ts");
const { UserAbortError } = await import("../../lib/errors.ts");
const { _setConfigDir } = await import("../../lib/config.ts");
const { listRuns, startRun } = await import("./lib/run-store.ts");

const captured = useCaptureLog();

let workDir: string;
let configDir: string;
let originalCwd: string;
let originalFetch: typeof globalThis.fetch;
let requests: { method: string; url: string; body: unknown }[];

const EXPORT = [
  { id: "u1", primary_email_address: "a@x.dev" },
  { id: "u2", primary_email_address: "b@x.dev" },
];

const runsDir = () => path.join(workDir, ".clerk", "migrate");

beforeAll(() => {
  originalMode = process.env.CLERK_MODE;
  process.env.CLERK_MODE = "human";
  originalCwd = process.cwd();
  originalFetch = globalThis.fetch;
  workDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "clerk-migrate-interactive-")));
  configDir = fs.mkdtempSync(path.join(os.tmpdir(), "clerk-migrate-interactive-config-"));
  _setConfigDir(configDir);
  process.chdir(workDir);
});

afterAll(() => {
  if (originalMode === undefined) delete process.env.CLERK_MODE;
  else process.env.CLERK_MODE = originalMode;
  globalThis.fetch = originalFetch;
  _setConfigDir(undefined);
  process.chdir(originalCwd);
  fs.rmSync(workDir, { recursive: true, force: true });
  fs.rmSync(configDir, { recursive: true, force: true });
});

beforeEach(() => {
  requests = [];
  confirmAnswer = true;
  reserveAnswer = true;
  confirmMessages = [];
  mockSelect.mockReset();
  mockText.mockReset();
  mockSelect.mockResolvedValue("clerk");
  mockText.mockResolvedValue("export.json");
  fs.rmSync(path.join(workDir, ".clerk"), { recursive: true, force: true });
  fs.rmSync(path.join(configDir, "config.json"), { force: true });
  fs.writeFileSync(path.join(workDir, "export.json"), JSON.stringify(EXPORT));
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input.toString());
    const method = init?.method ?? "GET";
    requests.push({
      method,
      url: url.toString(),
      body: init?.body ? JSON.parse(init.body as string) : null,
    });
    if (url.pathname === "/v1/instance") {
      return Response.json({ object: "instance", id: "ins_1", environment_type: "development" });
    }
    if (url.pathname === "/v1/users" && method === "GET") return Response.json([]);
    if (url.pathname === "/v1/users/count") return Response.json({ total_count: 0 });
    return Response.json({ id: "user_created" });
  }) as unknown as typeof fetch;
});

afterEach(() => {
  process.exitCode = 0;
});

const created = () =>
  requests.filter((r) => r.method === "POST" && new URL(r.url).pathname === "/v1/users");

const importOptions = { input: "export.json", source: "clerk", secretKey: "sk_test_x" };

describe("prompts for what was not passed", () => {
  test("bare `clerk migrate import` asks for the file, then the source, then imports", async () => {
    await run({ secretKey: "sk_test_x" });

    expect(mockText).toHaveBeenCalledTimes(1);
    expect(mockSelect).toHaveBeenCalledTimes(1);
    expect(created()).toHaveLength(2);
  });

  test("asks only for what was not passed", async () => {
    await run(importOptions);

    expect(mockText).not.toHaveBeenCalled();
    expect(mockSelect).not.toHaveBeenCalled();
  });

  // The envelope names the source, so asking would only invite a wrong answer.
  test("does not ask for a source when the file names its own", async () => {
    const exportRun = startRun(runsDir(), {
      kind: "export",
      target: { platform: "clerk" },
      source: "clerk",
    });
    const file = path.join(exportRun.dir, "export.json");
    fs.writeFileSync(
      file,
      JSON.stringify({
        clerkMigrate: 1,
        source: "clerk",
        exportedAt: "2026-09-01T00:00:00.000Z",
        runId: exportRun.record.id,
        users: EXPORT,
      }),
    );
    exportRun.update({ file: { path: file, sha256: "x" } });
    exportRun.finish();

    await run({ input: exportRun.record.id, secretKey: "sk_test_x" });

    expect(mockSelect).not.toHaveBeenCalled();
    expect(created()).toHaveLength(2);
  });
});

describe("consent", () => {
  test("asks before writing, naming how many users", async () => {
    await run(importOptions);

    expect(confirmMessages).toEqual(["Import 2 users?"]);
  });

  test("prints the checks before the question", async () => {
    await run(importOptions);

    expect(captured.err).toContain("Checks");
  });

  test("declining writes nothing to Clerk, and records no run", async () => {
    confirmAnswer = false;

    await expect(run(importOptions)).rejects.toThrow(UserAbortError);

    expect(created()).toHaveLength(0);
    expect(listRuns(runsDir())).toHaveLength(0);
  });

  test("--yes does not ask", async () => {
    await run({ ...importOptions, yes: true });

    expect(confirmMessages).toEqual([]);
    expect(created()).toHaveLength(2);
  });

  // `--json` means nobody reads a prompt, even at a terminal.
  test("--json never asks, and without --yes refuses", async () => {
    await expect(run({ ...importOptions, json: true })).rejects.toThrow(/needs consent/);

    expect(confirmMessages).toEqual([]);
    expect(created()).toHaveLength(0);
  });

  test("an unrecognized password hasher is rejected before any request", async () => {
    fs.writeFileSync(
      path.join(workDir, "export.json"),
      JSON.stringify([
        {
          id: "u1",
          primary_email_address: "a@x.dev",
          password_digest: "d",
          password_hasher: "rot13",
        },
      ]),
    );

    await expect(run(importOptions)).rejects.toThrow(/1 user would be rejected/);
    expect(created()).toHaveLength(0);
  });
});

describe("unverified identifiers", () => {
  const withUnverified = [
    { id: "u1", primary_email_address: "a@x.dev" },
    { id: "u2", primary_email_address: "b@x.dev", unverified_email_addresses: "c@x.dev" },
  ];
  const statuses = () =>
    created().map((r) => (r.body as Record<string, unknown>)?.email_address_identification_status);

  beforeEach(() => {
    fs.writeFileSync(path.join(workDir, "export.json"), JSON.stringify(withUnverified));
  });

  test("asks whether to reserve them, before consent, and a yes creates them reserved", async () => {
    await run(importOptions);

    expect(confirmMessages).toEqual([
      "1 user has an email or phone the source never verified. Create them reserved (usable for sign-in, locked to the user) instead of unverified?",
      "Import 2 users?",
    ]);
    expect(statuses()).toEqual([undefined, ["verified", "reserved"]]);
  });

  test("a no keeps them unverified, attached after the user exists", async () => {
    reserveAnswer = false;

    await run(importOptions);

    expect(statuses()).toEqual([undefined, undefined]);
    expect(requests.some((r) => new URL(r.url).pathname === "/v1/email_addresses")).toBe(true);
  });

  // `-y` is consent to write, not a yes to making unconfirmed addresses usable.
  test("--yes does not ask, and keeps them unverified", async () => {
    await run({ ...importOptions, yes: true });

    expect(confirmMessages).toEqual([]);
    expect(statuses()).toEqual([undefined, undefined]);
  });

  test("--reserve-unverified does not ask, and creates them reserved", async () => {
    await run({ ...importOptions, reserveUnverified: true });

    expect(confirmMessages).toEqual(["Import 2 users?"]);
    expect(statuses()).toEqual([undefined, ["verified", "reserved"]]);
  });
});
