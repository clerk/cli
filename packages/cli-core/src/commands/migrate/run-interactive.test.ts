/**
 * The human-mode half of `migrate run`: the wizard fills in missing flags, the
 * readiness report renders, and declining the confirmation writes nothing.
 *
 * Kept in its own file because `mock.module` registrations are process-lifetime,
 * and `bun test --parallel` puts several files in each worker — so a mocked
 * `prompts.ts` would leak into any file that later lands in the same worker and
 * imports the real one. Human mode itself needs no mock: `setMode` is the
 * supported override.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { getMode, setMode, type Mode } from "../../mode.ts";
import { listageStubs, useCaptureLog } from "../../test/lib/stubs.ts";

const mockSelect = mock(async () => "clerk" as unknown);
const mockText = mock(async () => "export.json" as unknown);
let confirmAnswer = true;
let originalMode: Mode;

mock.module("../../lib/listage.ts", () => ({
  ...listageStubs,
  select: (...args: unknown[]) => mockSelect(...(args as [])),
}));

// Every export of the real module must appear here — a missing one is a link
// error at import time, which takes down the whole file rather than one prompt.
mock.module("../../lib/prompts.ts", () => ({
  confirm: async () => confirmAnswer,
  multiselect: async () => [],
  text: (...args: unknown[]) => mockText(...(args as [])),
  password: async () => "",
  editor: async () => "{}",
}));

const { run } = await import("./run.ts");
const { deleteMigration } = await import("./delete.ts");
const { UserAbortError } = await import("../../lib/errors.ts");
const { loadSettings, saveSettings } = await import("./lib/settings.ts");
const { _setConfigDir } = await import("../../lib/config.ts");

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

const baseOptions = { transformer: "clerk", file: "export.json", secretKey: "sk_test_x" };

beforeAll(() => {
  originalMode = getMode();
  setMode("human");
  originalCwd = process.cwd();
  originalFetch = globalThis.fetch;
  workDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "clerk-migrate-interactive-")));
  configDir = fs.mkdtempSync(path.join(os.tmpdir(), "clerk-migrate-interactive-config-"));
  _setConfigDir(configDir);
  process.chdir(workDir);
});

afterAll(() => {
  setMode(originalMode);
  globalThis.fetch = originalFetch;
  _setConfigDir(undefined);
  process.chdir(originalCwd);
  fs.rmSync(workDir, { recursive: true, force: true });
  fs.rmSync(configDir, { recursive: true, force: true });
});

beforeEach(() => {
  requests = [];
  confirmAnswer = true;
  mockSelect.mockReset();
  mockText.mockReset();
  mockSelect.mockResolvedValue("clerk");
  mockText.mockResolvedValue("export.json");
  fs.rmSync(path.join(workDir, "logs"), { recursive: true, force: true });
  fs.rmSync(path.join(configDir, "config.json"), { force: true });
  fs.writeFileSync(path.join(workDir, "export.json"), JSON.stringify(EXPORT));
  stubInstanceSettings({ attributes: { email_address: { enabled: true } } });
});

afterEach(() => {
  process.exitCode = 0;
});

/** Stubs BAPI plus the FAPI environment lookup the readiness report needs. */
function stubInstanceSettings(settings: { attributes?: object; social?: object } | null) {
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = input.toString();
    requests.push({
      method: init?.method ?? "GET",
      url,
      body: init?.body ? JSON.parse(init.body as string) : null,
    });
    if (url.endsWith("/v1/domains")) {
      if (!settings) return new Response("nope", { status: 500 });
      return Response.json({
        data: [{ is_satellite: false, frontend_api_url: "https://fapi.example.com" }],
      });
    }
    if (url.includes("/v1/dev_browser")) return Response.json({ token: "jwt" });
    if (url.includes("/v1/environment")) return Response.json({ user_settings: settings });
    return Response.json({ id: "user_created" });
  }) as unknown as typeof fetch;
}

const created = () => requests.filter((r) => r.url.endsWith("/v1/users"));

describe("the wizard fills in missing flags", () => {
  test("bare `clerk migrate` prompts for the transformer and file, then imports", async () => {
    await run({ secretKey: "sk_test_x" });

    expect(mockSelect).toHaveBeenCalledTimes(1);
    expect(mockText).toHaveBeenCalledTimes(1);
    expect(created()).toHaveLength(2);
  });

  test("asks only for what the flags did not supply", async () => {
    await run({ ...baseOptions, transformer: "clerk" });

    expect(mockSelect).not.toHaveBeenCalled();
    expect(mockText).not.toHaveBeenCalled();
  });

  test("prompts for the file when only the transformer was passed", async () => {
    await run({ transformer: "clerk", secretKey: "sk_test_x" });

    expect(mockSelect).not.toHaveBeenCalled();
    expect(mockText).toHaveBeenCalledTimes(1);
  });

  test("records the wizard's answers for the next run", async () => {
    await run({ secretKey: "sk_test_x" });

    expect(await loadSettings()).toMatchObject({ transformer: "clerk", file: "export.json" });
  });
});

describe("the readiness report", () => {
  test("renders before the confirmation", async () => {
    await run(baseOptions);
    expect(captured.err).toContain("Migration readiness");
    expect(captured.err).toContain("2 users ready to import");
  });

  // The whole point of the report: seeing what will go wrong, then backing out
  // before a single user exists in the destination instance.
  test("declining afterwards writes nothing to Clerk", async () => {
    confirmAnswer = false;

    await expect(run(baseOptions)).rejects.toThrow(UserAbortError);

    expect(captured.err).toContain("Migration readiness");
    expect(created()).toHaveLength(0);
  });

  test("accepting proceeds with the import", async () => {
    confirmAnswer = true;

    await run(baseOptions);

    expect(created()).toHaveLength(2);
  });

  test("flags a field Clerk requires that not every user has", async () => {
    stubInstanceSettings({
      attributes: {
        email_address: { enabled: true, required: true },
        username: { enabled: true },
      },
    });
    fs.writeFileSync(
      path.join(workDir, "export.json"),
      JSON.stringify([
        { id: "u1", primary_email_address: "a@x.dev" },
        { id: "u2", username: "bob" },
      ]),
    );

    await run(baseOptions);

    expect(captured.err).toContain("1 user lacks it");
    expect(captured.err).toContain("1 setting needs attention");
  });

  test("degrades to a note when the instance settings cannot be read", async () => {
    stubInstanceSettings(null);

    await run(baseOptions);

    expect(captured.err).toContain("Could not read this instance's settings");
    expect(created()).toHaveLength(2);
  });

  test("is skipped for a -y run, which pays for no extra round-trips", async () => {
    await run({ ...baseOptions, yes: true });

    expect(requests.some((r) => r.url.endsWith("/v1/domains"))).toBe(false);
    expect(captured.err).not.toContain("Migration readiness");
    expect(created()).toHaveLength(2);
  });
});

describe("guards that still apply interactively", () => {
  test("the dev-instance 500-user cap", async () => {
    fs.writeFileSync(
      path.join(workDir, "export.json"),
      JSON.stringify(
        Array.from({ length: 501 }, (_, i) => ({
          id: `u${i}`,
          primary_email_address: `u${i}@x.dev`,
        })),
      ),
    );

    await expect(run(baseOptions)).rejects.toThrow(/development instance/);
    expect(created()).toHaveLength(0);
  });

  test("an unrecognized password hasher aborts before any request", async () => {
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

    await expect(run(baseOptions)).rejects.toThrow(/Invalid password hasher/);
    expect(created()).toHaveLength(0);
  });
});

describe("migrate delete confirmation", () => {
  /** Answers the external-id lookup, then the deletes. */
  function stubDeleteTargets(present: Record<string, string>) {
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = input.toString();
      requests.push({ method: init?.method ?? "GET", url, body: null });

      if (url.includes("/v1/users?")) {
        const asked = new URL(url).searchParams.getAll("external_id");
        return Response.json(
          asked
            .filter((externalId) => externalId in present)
            .map((externalId) => ({ id: present[externalId], external_id: externalId })),
        );
      }
      return Response.json({ deleted: true });
    }) as unknown as typeof fetch;
  }

  const deleted = () => requests.filter((r) => r.method === "DELETE");

  beforeEach(async () => {
    await saveSettings({ transformer: "clerk", file: "export.json" });
    stubDeleteTargets({ legacy_a: "user_1", legacy_b: "user_2" });
    fs.writeFileSync(
      path.join(workDir, "export.json"),
      JSON.stringify([
        { id: "legacy_a", primary_email_address: "a@x.dev" },
        { id: "legacy_b", primary_email_address: "b@x.dev" },
      ]),
    );
  });

  test("reports the count and confirms before deleting", async () => {
    confirmAnswer = true;

    await deleteMigration({ secretKey: "sk_test_x" });

    expect(captured.err).toContain("About to delete 2 users");
    expect(deleted()).toHaveLength(2);
  });

  // The undo for a bad undo does not exist, so declining must cost nothing.
  test("declining deletes nobody", async () => {
    confirmAnswer = false;

    await expect(deleteMigration({ secretKey: "sk_test_x" })).rejects.toThrow(UserAbortError);

    expect(deleted()).toHaveLength(0);
  });

  test("-y skips the prompt", async () => {
    confirmAnswer = false;

    await deleteMigration({ yes: true, secretKey: "sk_test_x" });

    expect(deleted()).toHaveLength(2);
  });
});
