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
import { keylessTargetStubs, listageStubs, useCaptureLog } from "../../test/lib/stubs.ts";
import type { InstanceTarget } from "../../lib/keyless-target.ts";

const mockSelect = mock(async () => "clerk" as unknown);
const mockText = mock(async () => "export.json" as unknown);
type MultiselectConfig = { options: { value: string; label: string; hint?: string }[] };
const mockMultiselect = mock(async (_config: MultiselectConfig) => [] as unknown[]);
let confirmAnswer = true;
let originalMode: Mode;

const ACCOUNT_TARGET: InstanceTarget = {
  kind: "account",
  ctx: {
    appId: "app_1",
    appLabel: "Migration Test",
    instanceId: "ins_1",
    instanceLabel: "development",
  },
  label: "Migration Test (development)",
};
let instanceTarget: InstanceTarget | Error = ACCOUNT_TARGET;

mock.module("../../lib/listage.ts", () => ({
  ...listageStubs,
  select: (...args: unknown[]) => mockSelect(...(args as [])),
}));

mock.module("../../lib/keyless-target.ts", () => ({
  ...keylessTargetStubs,
  resolveInstanceTarget: async () => {
    if (instanceTarget instanceof Error) throw instanceTarget;
    return instanceTarget;
  },
}));

// Every export of the real module must appear here — a missing one is a link
// error at import time, which takes down the whole file rather than one prompt.
mock.module("../../lib/prompts.ts", () => ({
  confirm: async () => confirmAnswer,
  multiselect: (...args: unknown[]) => mockMultiselect(...(args as [MultiselectConfig])),
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

let originalPlatformKey: string | undefined;

beforeAll(() => {
  originalMode = getMode();
  setMode("human");
  originalCwd = process.cwd();
  originalFetch = globalThis.fetch;
  // Pinned rather than inherited: the settings-fix write goes through the
  // Platform API, and CI has neither a `.env.local` nor a login session.
  originalPlatformKey = process.env.CLERK_PLATFORM_API_KEY;
  process.env.CLERK_PLATFORM_API_KEY = "ak_test";
  workDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "clerk-migrate-interactive-")));
  configDir = fs.mkdtempSync(path.join(os.tmpdir(), "clerk-migrate-interactive-config-"));
  _setConfigDir(configDir);
  process.chdir(workDir);
});

afterAll(() => {
  setMode(originalMode);
  globalThis.fetch = originalFetch;
  if (originalPlatformKey === undefined) delete process.env.CLERK_PLATFORM_API_KEY;
  else process.env.CLERK_PLATFORM_API_KEY = originalPlatformKey;
  _setConfigDir(undefined);
  process.chdir(originalCwd);
  fs.rmSync(workDir, { recursive: true, force: true });
  fs.rmSync(configDir, { recursive: true, force: true });
});

beforeEach(() => {
  requests = [];
  confirmAnswer = true;
  instanceTarget = ACCOUNT_TARGET;
  mockSelect.mockReset();
  mockText.mockReset();
  mockMultiselect.mockReset();
  mockSelect.mockResolvedValue("clerk");
  mockText.mockResolvedValue("export.json");
  mockMultiselect.mockResolvedValue([]);
  fs.rmSync(path.join(workDir, "logs"), { recursive: true, force: true });
  fs.rmSync(path.join(configDir, "config.json"), { force: true });
  fs.writeFileSync(path.join(workDir, "export.json"), JSON.stringify(EXPORT));
  stubInstanceSettings({ attributes: { email_address: { enabled: true } } });
});

afterEach(() => {
  process.exitCode = 0;
});

type StubSettings = { attributes?: object; social?: object } | null;

let currentSettings: StubSettings = null;
/** What the instance reports once a config PATCH lands, when a test sets one. */
let settingsAfterFix: StubSettings = null;

/** Stubs BAPI plus the FAPI environment lookup the readiness report needs. */
function stubInstanceSettings(settings: StubSettings) {
  currentSettings = settings;
  settingsAfterFix = null;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = input.toString();
    requests.push({
      method: init?.method ?? "GET",
      url,
      body: init?.body ? JSON.parse(init.body as string) : null,
    });
    if (url.endsWith("/v1/domains")) {
      if (!currentSettings) return new Response("nope", { status: 500 });
      return Response.json({
        data: [{ is_satellite: false, frontend_api_url: "https://fapi.example.com" }],
      });
    }
    if (url.includes("/v1/dev_browser")) return Response.json({ token: "jwt" });
    if (url.includes("/v1/environment")) return Response.json({ user_settings: currentSettings });
    if (url.endsWith("/instances/ins_1/config")) {
      if (settingsAfterFix) currentSettings = settingsAfterFix;
      return Response.json({ config_version: "v1_patched" });
    }
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
    expect(captured.err).toContain("2 users in this file");
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

    // The outcome block is the point: one user has no email, and an instance
    // that requires one will refuse them.
    expect(captured.err).toContain("1 user will not be imported");
    expect(captured.err).toContain("1 has no email, which this instance requires");
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

describe("fixing the instance's settings from the report", () => {
  /** An export whose second user has no email, against a required-email instance. */
  function blockedOnRequiredEmail() {
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
  }

  /** Two flagged rows: email required with a user lacking it, username switched off. */
  function blockedOnTwoSettings() {
    stubInstanceSettings({
      attributes: {
        email_address: { enabled: true, required: true },
        username: { enabled: false },
      },
    });
    fs.writeFileSync(
      path.join(workDir, "export.json"),
      JSON.stringify([
        { id: "u1", primary_email_address: "a@x.dev", username: "alice" },
        { id: "u2", username: "bob" },
      ]),
    );
  }

  const patched = () => requests.filter((r) => r.url.endsWith("/instances/ins_1/config"));
  const offered = (round = 0) => mockMultiselect.mock.calls[round]?.[0]?.options ?? [];

  // Plain labels only: the config leaf each one writes is internal detail an
  // operator cannot act on and does not need to read.
  test("offers one change per blocking row, named in plain terms", async () => {
    blockedOnRequiredEmail();

    await run(baseOptions);

    expect(offered()).toEqual([
      { value: "email_address", label: "Make Email optional at sign-up" },
    ]);
  });

  test("does not ask when nothing is blocking", async () => {
    await run(baseOptions);

    expect(mockMultiselect).not.toHaveBeenCalled();
    expect(created()).toHaveLength(2);
  });

  // Relaxing an instance's sign-up requirements is a real decision, so nothing
  // is preselected and an empty answer must leave the instance untouched.
  test("selecting nothing changes nothing and continues to the import", async () => {
    blockedOnRequiredEmail();
    mockMultiselect.mockResolvedValue([]);

    await run(baseOptions);

    expect(patched()).toHaveLength(0);
    expect(created()).toHaveLength(2);
  });

  test("selecting a change patches the instance and re-renders the report", async () => {
    blockedOnRequiredEmail();
    mockMultiselect.mockResolvedValue(["email_address"]);

    await run(baseOptions);

    expect(patched()).toHaveLength(1);
    expect(patched()[0]).toMatchObject({
      method: "PATCH",
      body: { auth_email: { required_for_sign_up: false } },
    });
    expect(captured.err).toContain("Updated 1 setting");
    // The redraw clears the row that was just fixed, so the confirmation that
    // follows is against the settings the write established.
    expect(captured.err).toContain("Every field in this file is configured in Clerk");
    expect(created()).toHaveLength(2);
  });

  /**
   * The redraw must not re-read the Frontend API. It is eventually consistent,
   * so a fetch this soon after the write returns the pre-write settings and
   * redraws the report with every row the operator just cleared still flagged.
   */
  test("redraws from the write rather than re-reading stale settings", async () => {
    blockedOnRequiredEmail();
    // Anything read back now would still say "required" — as it did in practice.
    settingsAfterFix = {
      attributes: {
        email_address: { enabled: true, required: true },
        username: { enabled: true },
      },
    };
    mockMultiselect.mockResolvedValue(["email_address"]);

    await run(baseOptions);

    expect(requests.filter((r) => r.url.includes("/v1/environment"))).toHaveLength(1);
    expect(captured.err).toContain("Every field in this file is configured in Clerk");
    // Flagged in the first report, and only there — the redraw is clean even
    // though a re-read at this moment would still have reported it.
    expect(captured.err.split("setting needs attention")).toHaveLength(2);
  });

  // A keyless application is only reachable through the Backend API, which has
  // no route for any of these settings — saying so beats a confusing rejection.
  test("stands down for a keyless application and still imports", async () => {
    blockedOnRequiredEmail();
    instanceTarget = {
      kind: "keyless",
      keyless: { secretKey: "sk_test_x", source: ".env" },
      label: "keyless",
    };
    mockMultiselect.mockResolvedValue(["email_address"]);

    await run(baseOptions);

    expect(patched()).toHaveLength(0);
    expect(captured.err).toContain("clerk auth login");
    expect(created()).toHaveLength(2);
  });

  /**
   * Each redraw is another decision point, not a receipt. Applying one change
   * routinely leaves others still worth making, and an operator should not have
   * to re-run the whole command to reach them.
   */
  describe("offering again while anything is still flagged", () => {
    test("re-offers what is left, without the change already applied", async () => {
      blockedOnTwoSettings();
      mockMultiselect.mockResolvedValueOnce(["email_address"]);
      mockMultiselect.mockResolvedValueOnce(["username"]);

      await run(baseOptions);

      expect(offered(0).map((option) => option.value)).toEqual(["email_address", "username"]);
      expect(offered(1).map((option) => option.value)).toEqual(["username"]);
      expect(patched()).toHaveLength(2);
      expect(patched()[1]).toMatchObject({
        body: { auth_username: { used_for_sign_up: true } },
      });
    });

    test("stops once nothing is flagged, rather than asking again", async () => {
      blockedOnTwoSettings();
      mockMultiselect.mockResolvedValueOnce(["email_address"]);
      mockMultiselect.mockResolvedValueOnce(["username"]);

      await run(baseOptions);

      expect(mockMultiselect).toHaveBeenCalledTimes(2);
      expect(captured.err).toContain("Every field in this file is configured in Clerk");
      expect(created()).toHaveLength(2);
    });

    test("stops when the operator skips, leaving the rest flagged", async () => {
      blockedOnTwoSettings();
      mockMultiselect.mockResolvedValueOnce(["email_address"]);
      mockMultiselect.mockResolvedValueOnce([]);

      await run(baseOptions);

      expect(mockMultiselect).toHaveBeenCalledTimes(2);
      expect(patched()).toHaveLength(1);
      expect(created()).toHaveLength(2);
    });

    // A selection naming nothing on offer is the same as no selection, and must
    // not become an empty PATCH.
    test("sends nothing when the selection matches no offered change", async () => {
      blockedOnRequiredEmail();
      mockMultiselect.mockResolvedValue(["not_a_real_change"]);

      await run(baseOptions);

      expect(patched()).toHaveLength(0);
      expect(created()).toHaveLength(2);
    });
  });

  test("warns instead of failing the run when the instance cannot be resolved", async () => {
    blockedOnRequiredEmail();
    instanceTarget = new Error("not linked");
    mockMultiselect.mockResolvedValue(["email_address"]);

    await run(baseOptions);

    expect(patched()).toHaveLength(0);
    expect(captured.err).toContain("nothing was changed");
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
