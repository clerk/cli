/**
 * The human-mode half of `migrate import`: the prompts fill in what was not
 * passed, and nothing is written until the operator says yes.
 *
 * Kept in its own file because `mock.module` replaces `prompts.ts` for the whole
 * file; `bun test --parallel` isolates each file, so the mock ends with it.
 * Human mode is set through `CLERK_MODE` rather than `setMode`, because
 * `mode.ts` has no way to clear a forced mode once the file is done.
 */

import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  mock,
  test,
  spyOn,
} from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { listageStubs, useCaptureLog } from "../../test/lib/stubs.ts";

const mockSelect = mock(async () => "clerk" as unknown);
const mockText = mock(async () => "export.json" as unknown);
const mockPassword = mock(async () => "" as unknown);
let confirmAnswer = true;
/** User settings the instance serves, or none (the settings read fails). */
let instanceSettings: Record<string, unknown> | undefined;
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
  password: (...args: unknown[]) => mockPassword(...(args as [])),
  editor: async () => "{}",
}));

const { run } = await import("./run.ts");
const { terminal } = await import("./lib/terminal.ts");
// The prompts are stubs; whether this process has a terminal is a test of its own.
const terminalAvailable = spyOn(terminal, "available");
const { UserAbortError } = await import("../../lib/errors.ts");
const { _setConfigDir } = await import("../../lib/config.ts");
const { listRuns, sha256File, startRun } = await import("./lib/run-store.ts");

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
  terminalAvailable.mockRestore();
  if (originalMode === undefined) delete process.env.CLERK_MODE;
  else process.env.CLERK_MODE = originalMode;
  globalThis.fetch = originalFetch;
  _setConfigDir(undefined);
  process.chdir(originalCwd);
  fs.rmSync(workDir, { recursive: true, force: true });
  fs.rmSync(configDir, { recursive: true, force: true });
});

beforeEach(() => {
  terminalAvailable.mockReturnValue(true);
  requests = [];
  confirmAnswer = true;
  instanceSettings = undefined;
  reserveAnswer = true;
  confirmMessages = [];
  mockSelect.mockReset();
  mockText.mockReset();
  mockPassword.mockClear();
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
    if (url.pathname === "/v1/domains") {
      if (!instanceSettings) return new Response("nope", { status: 500 });
      return Response.json({
        data: [{ is_satellite: false, frontend_api_url: "https://fapi.example.com" }],
      });
    }
    if (url.pathname.includes("/v1/dev_browser")) return Response.json({ token: "jwt" });
    if (url.pathname.includes("/v1/environment")) {
      return Response.json({ user_settings: instanceSettings });
    }
    return Response.json({ id: "user_created" });
  }) as unknown as typeof fetch;
});

afterEach(() => {
  process.exitCode = 0;
});

const created = () =>
  requests.filter((r) => r.method === "POST" && new URL(r.url).pathname === "/v1/users");

const importOptions = { input: "export.json", source: "clerk", secretKey: "sk_test_x" };

// A yes at the prompt is consent to this run, so the retry it suggests runs
// as printed, like `runs <id>`'s continue.
test("after a yes at the prompt, the suggested retry carries --yes", async () => {
  const clerk = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const body = typeof init?.body === "string" ? init.body : "";
    return init?.method === "POST" && body.includes('"u2"')
      ? Response.json(
          { errors: [{ message: "taken", code: "form_identifier_exists" }] },
          { status: 422 },
        )
      : clerk(input, init);
  }) as typeof fetch;

  await run(importOptions);

  expect(Bun.stripANSI(captured.err)).toMatch(/--yes` to retry them/);
});

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
    exportRun.update({ file: { path: file, sha256: sha256File(file) } });
    exportRun.finish();

    await run({ input: exportRun.record.id, secretKey: "sk_test_x" });

    expect(mockSelect).not.toHaveBeenCalled();
    expect(created()).toHaveLength(2);
  });
});

// `CLERK_MODE=human` with no terminal: the prompt would fail to open one and spin.
test("with no terminal, refuses for consent rather than prompting", async () => {
  terminalAvailable.mockReturnValue(false);

  await expect(run(importOptions)).rejects.toThrow(/--yes/);

  expect(confirmMessages).toEqual([]);
  expect(requests.some((r) => r.url.endsWith("/v1/users") && r.method === "POST")).toBe(false);
});

describe("consent", () => {
  test("asks before writing, naming how many users", async () => {
    await run(importOptions);

    expect(confirmMessages).toEqual(["Import 2 users?"]);
  });

  test("names the users it would skip", async () => {
    fs.writeFileSync(path.join(workDir, "export.json"), JSON.stringify([...EXPORT, { id: "u3" }]));
    await run({ ...importOptions, allowPartial: true });

    expect(confirmMessages).toEqual(["Create 2 users and skip 1 user?"]);
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
    await expect(run({ ...importOptions, json: true })).rejects.toThrow(/Pass --yes to confirm/);

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

describe("firebase hash parameters", () => {
  // `-y` is "import without prompting", at a terminal too.
  test("-y never asks for them, and names the flags instead", async () => {
    fs.writeFileSync(
      path.join(workDir, "export.json"),
      JSON.stringify({
        users: [{ localId: "fb1", email: "a@x.dev", passwordHash: "SGFzaA==", salt: "U2FsdA==" }],
      }),
    );

    await expect(run({ ...importOptions, source: "firebase", yes: true })).rejects.toThrow(
      /--firebase-signer-key --firebase-salt-separator --firebase-rounds --firebase-mem-cost/,
    );
    expect(mockPassword).not.toHaveBeenCalled();
    expect(mockText).not.toHaveBeenCalled();
    expect(created()).toHaveLength(0);
  });

  // The suggested retry runs with --yes, which never asks again.
  test("parameters entered at the prompt go into the retry the import suggests", async () => {
    fs.writeFileSync(
      path.join(workDir, "export.json"),
      JSON.stringify({
        users: [
          { localId: "fb1", email: "a@x.dev", passwordHash: "SGFzaA==", salt: "U2FsdA==" },
          { localId: "fb2", email: "b@x.dev", passwordHash: "SGFzaA==", salt: "U2FsdA==" },
        ],
      }),
    );
    mockPassword.mockResolvedValueOnce("c2lnbmVy");
    mockText.mockImplementation((async (prompt: { message: string }) =>
      prompt.message.includes("salt separator")
        ? "c2VwYXJhdG9y"
        : prompt.message === "rounds"
          ? "8"
          : "14") as unknown as typeof mockText);

    // fb2's create fails, so the run ends partial and suggests the retry.
    const clerk = globalThis.fetch;
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const body = typeof init?.body === "string" ? init.body : "";
      return init?.method === "POST" && body.includes('"fb2"')
        ? Response.json(
            { errors: [{ message: "taken", code: "form_identifier_exists" }] },
            { status: 422 },
          )
        : clerk(input, init);
    }) as typeof fetch;
    await run({ ...importOptions, source: "firebase" });

    const err = Bun.stripANSI(captured.err);
    expect(err).toContain(
      "--firebase-signer-key SIGNER_KEY --firebase-salt-separator SALT_SEPARATOR --firebase-rounds ROUNDS --firebase-mem-cost MEM_COST",
    );
    expect(err).not.toContain("c2lnbmVy");
  });
});

describe("legal consent", () => {
  beforeEach(() => {
    instanceSettings = {
      attributes: { email_address: { enabled: true } },
      sign_up: { legal_consent_enabled: true },
      // A way in besides a password, so users without one import.
      enterprise_sso: { enabled: true },
    };
  });

  test("asks, and a yes imports the users without it", async () => {
    await run(importOptions);

    expect(confirmMessages[0]).toContain("no legal acceptance on record");
    expect(created()).toHaveLength(2);
  });

  // A rerun with --yes skips the prompt, so the command has to carry the answer.
  test("a yes carries into the command the refusal suggests", async () => {
    fs.writeFileSync(
      path.join(workDir, "export.json"),
      JSON.stringify([
        ...EXPORT,
        {
          id: "u3",
          primary_email_address: "c@x.dev",
          password_digest: "d",
          password_hasher: "rot13",
        },
      ]),
    );

    const error = (await run(importOptions).catch((caught: unknown) => caught)) as {
      examples?: { command: string }[];
    };

    expect(confirmMessages[0]).toContain("no legal acceptance on record");
    expect(error.examples?.[0]?.command).toContain("--skip-legal-checks");
  });

  // `-y` is "import without prompting": the checks reject these users instead.
  test("--yes does not ask, and the checks reject them", async () => {
    await expect(run({ ...importOptions, yes: true })).rejects.toThrow(/2 users would be rejected/);

    expect(confirmMessages).toEqual([]);
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
      "1 user has an email or phone the source never verified. Create them reserved (usable for sign-in, locked to the user) instead of unverified? A reserved one another user already holds rejects its user, not just that address.",
      "Import 2 users?",
    ]);
    expect(statuses()).toEqual([undefined, ["verified", "reserved"]]);
  });

  /** Rewrites the only run as one a crash stopped after creating u1, and returns its folder. */
  const interruptAfterU1 = (patch: Record<string, unknown> = {}): string => {
    const [id] = fs.readdirSync(runsDir());
    const dir = path.join(runsDir(), id!);
    const record = JSON.parse(fs.readFileSync(path.join(dir, "run.json"), "utf-8"));
    delete record.finishedAt;
    fs.writeFileSync(path.join(dir, "run.json"), JSON.stringify({ ...record, ...patch }));
    const lines = fs.readFileSync(path.join(dir, "users.ndjson"), "utf-8").split("\n");
    fs.writeFileSync(
      path.join(dir, "users.ndjson"),
      lines.filter((line) => line.includes('"u1"')).join("\n") + "\n",
    );
    requests = [];
    confirmMessages = [];
    return dir;
  };

  // A human said yes, and the continue runs under -y, which never asks.
  test("a continued run creates the rest in the mode it recorded, without asking", async () => {
    await run(importOptions);
    interruptAfterU1();

    await run({ ...importOptions, yes: true });

    expect(confirmMessages).toEqual([]);
    expect(statuses()).toEqual([["verified", "reserved"]]);
  });

  test("refuses --reserve-unverified on a continue of a run that kept them unverified", async () => {
    reserveAnswer = false;
    await run(importOptions);
    interruptAfterU1();

    await expect(run({ ...importOptions, yes: true, reserveUnverified: true })).rejects.toThrow(
      /created its users' unverified emails and phones unverified/,
    );
    expect(created()).toHaveLength(0);
  });

  test("a run recorded before the mode was asks again", async () => {
    await run(importOptions);
    interruptAfterU1({ reserveUnverified: undefined });

    await run(importOptions);

    expect(confirmMessages.some((message) => message.includes("never verified"))).toBe(true);
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

  // A yes at the prompt is a choice; the re-run the refusal suggests must
  // keep it, or it would reject the users it let through.
  test("a yes carries into the command a refusal suggests", async () => {
    fs.writeFileSync(
      path.join(workDir, "export.json"),
      JSON.stringify([
        ...withUnverified,
        {
          id: "u3",
          primary_email_address: "d@x.dev",
          password_digest: "d",
          password_hasher: "rot13",
        },
      ]),
    );

    const error = (await run(importOptions).catch((caught: unknown) => caught)) as {
      examples?: { command: string }[];
    };

    expect(error.examples?.map((example) => example.command)).toEqual([
      "clerk migrate import export.json --source clerk --reserve-unverified --secret-key <key> --allow-partial --yes",
    ]);
  });

  test("--reserve-unverified does not ask, and creates them reserved", async () => {
    await run({ ...importOptions, reserveUnverified: true });

    expect(confirmMessages).toEqual(["Import 2 users?"]);
    expect(statuses()).toEqual([undefined, ["verified", "reserved"]]);
  });
});
