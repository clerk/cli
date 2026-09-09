import { test, expect, describe, beforeEach, afterEach, spyOn, mock } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { _setConfigDir, setProfile } from "../../lib/config.ts";
import {
  useCaptureLog,
  credentialStoreStubs,
  gitStubs,
  libPromptsStubs,
  listageStubs,
  stubFetch,
} from "../../test/lib/stubs.ts";
import { INSECURE_CONFIG, SECURE_CONFIG } from "./fixtures.ts";
import { deepMerge } from "./merge.ts";
import type { FixOptions, FixSummary } from "./types.ts";

mock.module("../../lib/credential-store.ts", () => credentialStoreStubs);
mock.module("../../lib/git.ts", () => gitStubs);
mock.module("../../lib/prompts.ts", () => libPromptsStubs);
mock.module("../../lib/listage.ts", () => ({
  ...listageStubs,
  select: async (config: { default?: unknown }) => config.default,
}));
mock.module("../../lib/spinner.ts", () => ({
  intro: () => {},
  outro: () => {},
  pausedOutro: () => {},
  bar: () => {},
  withGutter: async (
    _title: string,
    fn: (controls: { setNextSteps: (steps: readonly string[]) => void }) => Promise<unknown>,
  ) => fn({ setNextSteps: () => {} }),
  withSpinner: async (_msg: string, fn: () => Promise<unknown>) => fn(),
}));

interface Captured {
  method: string;
  url: string;
  body: Record<string, unknown> | null;
}

describe("security fix", () => {
  const originalEnv = { ...process.env };
  const originalFetch = globalThis.fetch;
  let tempDir: string;
  let logSpy: ReturnType<typeof spyOn>;
  let errorSpy: ReturnType<typeof spyOn>;
  let requests: Captured[];
  const captured = useCaptureLog();

  function serve(config: Record<string, unknown>) {
    stubFetch(async (input, init) => {
      const url = input.toString();
      const method = init?.method ?? "GET";
      const body = typeof init?.body === "string" ? JSON.parse(init.body) : null;
      requests.push({ method, url, body });
      if (!url.includes("/config")) throw new Error(`Unexpected fetch: ${url}`);
      const result = method === "PATCH" ? deepMerge(config, body) : config;
      return new Response(JSON.stringify(result), { status: 200 });
    });
  }

  async function link() {
    await setProfile(process.cwd(), {
      workspaceId: "org_1",
      appId: "app_1",
      instances: { development: "ins_dev" },
    });
  }

  async function run(ids: string[] = [], options: FixOptions = {}) {
    const { securityFix } = await import("./fix.ts");
    return securityFix(ids, options);
  }

  const patches = () => requests.filter((r) => r.method === "PATCH");

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "clerk-security-fix-test-"));
    _setConfigDir(tempDir);
    process.env.CLERK_PLATFORM_API_KEY = "test_key";
    process.env.CLERK_PLATFORM_API_URL = "https://test-api.clerk.com";
    process.env.CLERK_MODE = "human";
    requests = [];
    logSpy = spyOn(console, "log").mockImplementation(() => {});
    errorSpy = spyOn(console, "error").mockImplementation(() => {});
    serve(INSECURE_CONFIG);
    await link();
  });

  afterEach(async () => {
    _setConfigDir(undefined);
    process.env = { ...originalEnv };
    globalThis.fetch = originalFetch;
    logSpy.mockRestore();
    errorSpy.mockRestore();
    await rm(tempDir, { recursive: true, force: true });
  });

  describe("argument validation", () => {
    test("agent mode requires ids or --all", async () => {
      process.env.CLERK_MODE = "agent";
      await expect(run()).rejects.toThrow("Pass one or more check ids, or --all");
      expect(requests).toHaveLength(0);
    });

    test("human mode with no ids opens a picker preselecting the critical and recommended gaps", async () => {
      await run([], { yes: true, json: true });
      const summary = JSON.parse(captured.out) as FixSummary;
      expect(summary.applied).toContain("user-lockout");
      expect(summary.applied).not.toContain("mfa");
      expect(summary.applied).not.toContain("block-email-subaddresses");
      expect(summary.remaining).toContain("block-email-subaddresses");
      expect(summary.remaining).toContain("mfa");
    });

    test("human mode picker on a secure instance has nothing to offer", async () => {
      serve(SECURE_CONFIG);
      await run([], { yes: true });
      expect(captured.err).toContain("Nothing to fix");
      expect(patches()).toHaveLength(0);
    });

    test("rejects ids together with --all", async () => {
      await expect(run(["user-lockout"], { all: true })).rejects.toThrow("not both");
    });

    test("rejects unknown ids and lists the valid ones", async () => {
      await expect(run(["nope"])).rejects.toThrow(
        /Unknown check: nope.*Valid ids: bot-protection/s,
      );
      expect(requests).toHaveLength(0);
    });

    test("agent mode requires --yes", async () => {
      process.env.CLERK_MODE = "agent";
      await expect(run(["user-lockout"])).rejects.toThrow("Pass --yes");
      expect(requests).toHaveLength(0);
    });

    test("a blocked id without its prerequisite is reported before anything is written", async () => {
      await expect(run(["mfa-required", "user-lockout"], { yes: true })).rejects.toThrow(
        /manual change:.*mfa-required: Make "Two-factor authentication" available first/s,
      );
      expect(patches()).toHaveLength(0);
    });
  });

  test("applies one merged patch for several ids", async () => {
    await run(["user-lockout", "lockout-threshold", "device-trust"], { yes: true });
    expect(patches()).toHaveLength(1);
    expect(patches()[0]!.body).toEqual({
      auth_attack_protection: { user_lockout: { enabled: true, max_attempts: 10 } },
      auth_password: { device_trust: { enabled: true } },
    });
    // Catalog order: prerequisites and critical checks first.
    expect(captured.err).toContain("Applied: user-lockout, device-trust, lockout-threshold");
  });

  test("--check unions with positional ids", async () => {
    await run(["user-lockout"], { check: ["device-trust", "user-lockout"], yes: true });
    expect(Object.keys(patches()[0]!.body!)).toEqual(["auth_attack_protection", "auth_password"]);
  });

  test("--all fixes the critical and recommended gaps and leaves good-to-have alone", async () => {
    await run([], { all: true, yes: true, json: true });
    const body = patches()[0]!.body!;
    expect(body.auth_password).toMatchObject({ min_length: 8 });
    expect(body).not.toHaveProperty("auth_multi_factor");
    expect(body).not.toHaveProperty("session_settings");
    const summary = JSON.parse(captured.out) as FixSummary;
    expect(summary.remaining.sort()).toEqual([
      "block-disposable-email",
      "block-email-subaddresses",
      "email-link-same-client",
      "mfa",
      "mfa-required",
      "session-lifetime",
    ]);
  });

  test("--all --good-to-have fixes every unmet recommendation with a patch", async () => {
    await run([], { all: true, goodToHave: true, yes: true });
    const body = patches()[0]!.body!;
    expect(body).toHaveProperty("session_settings");
    expect(body).toHaveProperty("auth_access_control");

    const { evaluate } = await import("./evaluate.ts");
    const projected = deepMerge(INSECURE_CONFIG, body);
    const remaining = evaluate(
      { config: projected, environmentType: "development" },
      { appId: "app_1", instanceId: "ins_dev", environmentType: "development", label: "" },
    ).filter((f) => f.status !== "met");
    // Enabling passkeys also satisfies the passwordless check.
    expect(remaining.map((f) => f.id).sort()).toEqual(["mfa", "mfa-required"]);
  });

  test("--dry-run sends the patch with dry_run=true", async () => {
    await run(["user-lockout"], { dryRun: true });
    expect(patches()).toHaveLength(1);
    expect(patches()[0]!.url).toContain("dry_run=true");
    expect(captured.err).toContain("[dry-run]");
  });

  test("met ids are skipped and nothing is sent", async () => {
    serve(SECURE_CONFIG);
    await run(["user-lockout"], { yes: true });
    expect(patches()).toHaveLength(0);
    expect(captured.err).toMatch(/Skipping .*user-lockout.*: already met/);
    expect(captured.err).toContain("Nothing to fix");
  });

  test("not applicable ids are skipped", async () => {
    serve({ ...INSECURE_CONFIG, auth_phone: { used_for_sign_up: false } });
    await run(["phone-verification"], { yes: true });
    expect(captured.err).toMatch(/Skipping .*phone-verification.*: not applicable/);
  });

  test("agent mode prints a JSON summary with the score change on stdout", async () => {
    process.env.CLERK_MODE = "agent";
    await run(["user-lockout", "bot-protection"], { yes: true });
    const summary = JSON.parse(captured.out) as FixSummary;
    expect(summary).toMatchObject({
      changed: true,
      dryRun: false,
      applied: ["bot-protection", "user-lockout"],
      skipped: [],
    });
    expect(summary.score.after.met).toBe(summary.score.before.met + 2);
    expect(summary.remaining).not.toContain("user-lockout");
    expect(summary.remaining).toContain("device-trust");
    expect(captured.err).toContain("Grade");
  });

  test("--json prints the summary in human mode too", async () => {
    await run(["user-lockout"], { yes: true, json: true });
    expect((JSON.parse(captured.out) as FixSummary).applied).toEqual(["user-lockout"]);
  });

  test("the after-score comes from the server's response, not the local projection", async () => {
    // A server that ignores the patch must not be reported as an improvement.
    stubFetch(async (input, init) => {
      requests.push({ method: init?.method ?? "GET", url: input.toString(), body: null });
      return new Response(JSON.stringify(INSECURE_CONFIG), { status: 200 });
    });
    await run(["user-lockout"], { yes: true, json: true });
    const summary = JSON.parse(captured.out) as FixSummary;
    expect(summary.score.after).toEqual(summary.score.before);
    expect(summary.remaining).toContain("user-lockout");
  });

  test("dry-run scores the server's `after` envelope layered over the fetched document", async () => {
    // The Platform API answers a dry-run with only the touched sections.
    stubFetch(async (input, init) => {
      const method = init?.method ?? "GET";
      const body = typeof init?.body === "string" ? JSON.parse(init.body) : null;
      requests.push({ method, url: input.toString(), body });
      if (method !== "PATCH") return new Response(JSON.stringify(INSECURE_CONFIG), { status: 200 });
      const touched = Object.keys(body);
      const pick = (doc: Record<string, unknown>) =>
        Object.fromEntries(touched.map((k) => [k, doc[k]]));
      const envelope = {
        config_version: "v1_x",
        dry_run: true,
        before: pick(INSECURE_CONFIG),
        after: pick(deepMerge(INSECURE_CONFIG, body)),
      };
      return new Response(JSON.stringify(envelope), { status: 200 });
    });
    await run(["user-lockout"], { dryRun: true, json: true });
    const summary = JSON.parse(captured.out) as FixSummary;
    expect(summary.score.after.met).toBe(summary.score.before.met + 1);
    expect(summary.score.after.total).toBe(summary.score.before.total);
    expect(summary.remaining).not.toContain("user-lockout");
  });

  test("a partial PATCH response is merged over the fetched document", async () => {
    stubFetch(async (input, init) => {
      const method = init?.method ?? "GET";
      const body = typeof init?.body === "string" ? JSON.parse(init.body) : null;
      requests.push({ method, url: input.toString(), body });
      const doc =
        method === "PATCH"
          ? { auth_password: deepMerge(INSECURE_CONFIG, body).auth_password }
          : INSECURE_CONFIG;
      return new Response(JSON.stringify(doc), { status: 200 });
    });
    await run(["device-trust"], { yes: true, json: true });
    const summary = JSON.parse(captured.out) as FixSummary;
    expect(summary.score.after.total).toBe(summary.score.before.total);
    expect(summary.score.after.met).toBe(summary.score.before.met + 1);
  });

  test("--all with --dry-run reports the projected score", async () => {
    await run([], { all: true, goodToHave: true, dryRun: true, json: true });
    const summary = JSON.parse(captured.out) as FixSummary;
    expect(summary.dryRun).toBe(true);
    expect(summary.changed).toBe(true);
    expect(summary.remaining.sort()).toEqual(["mfa", "mfa-required"]);
    expect(captured.err).toContain("[dry-run] projected");
  });

  test("agent mode summary for nothing to fix", async () => {
    process.env.CLERK_MODE = "agent";
    serve(SECURE_CONFIG);
    await run(["user-lockout"], { yes: true });
    const summary = JSON.parse(captured.out) as FixSummary;
    expect(summary).toMatchObject({
      changed: false,
      applied: [],
      skipped: [{ id: "user-lockout", reason: "met" }],
      dryRun: false,
      remaining: [],
    });
    expect(summary.score.after).toEqual(summary.score.before);
  });

  test("a manual id in the selection points at the fixable subset", async () => {
    let error: unknown;
    await run(["mfa-required", "user-lockout", "device-trust"], { yes: true }).catch(
      (e) => (error = e),
    );
    const { examples } = error as { examples: Array<{ command: string }> };
    expect(examples[0]!.command).toBe(
      "clerk security fix user-lockout device-trust --app app_1 --instance ins_dev",
    );
  });

  test("requires MFA enrollment even when sign-in second-factor verification is enabled", async () => {
    serve(
      deepMerge(SECURE_CONFIG, {
        auth_multi_factor: { required_for_sign_in: true, required_for_sign_up: false },
      }),
    );
    await run(["mfa-required"], { yes: true, json: true });
    expect(patches()[0]!.body).toEqual({
      auth_multi_factor: { required_for_sign_up: true },
    });
    expect((JSON.parse(captured.out) as FixSummary).remaining).not.toContain("mfa-required");
  });

  test.each([true, false])(
    "sign-in breach fix enables HIBP when enforcement is %s",
    async (enforce) => {
      serve(
        deepMerge(SECURE_CONFIG, {
          auth_password: { disable_hibp: true, enforce_hibp_on_sign_in: enforce },
        }),
      );
      await run(["breach-detection-sign-in"], { yes: true, json: true });
      expect(patches()[0]!.body).toEqual({
        auth_password: { disable_hibp: false, enforce_hibp_on_sign_in: true },
      });
      const summary = JSON.parse(captured.out) as FixSummary;
      expect(summary.remaining).not.toContain("breach-detection-sign-in");
      expect(summary.remaining).not.toContain("breach-detection");
    },
  );

  describe("decisions", () => {
    test.each([false, true])("rejects backup codes alone before writing (all=%s)", async (all) => {
      await expect(
        run(all ? [] : ["mfa"], {
          all,
          factors: ["backup-code"],
          yes: true,
        }),
      ).rejects.toThrow("Backup codes require another second factor");
      expect(patches()).toHaveLength(0);
    });

    test("accepts SMS with backup codes", async () => {
      await run(["mfa"], { factors: ["sms,backup-code"], yes: true });
      expect(patches()[0]!.body).toEqual({
        auth_multi_factor: { backup_code: { enabled: true } },
        auth_phone: { used_for_second_factor: true, second_factor_strategies: ["phone_code"] },
      });
    });

    test("--factors applies the chosen second factors", async () => {
      await run(["mfa"], { factors: ["authenticator,sms"], yes: true, json: true });
      expect(patches()[0]!.body).toEqual({
        auth_multi_factor: { authenticator_app: { enabled: true } },
        auth_phone: { used_for_second_factor: true, second_factor_strategies: ["phone_code"] },
      });
      const summary = JSON.parse(captured.out) as FixSummary;
      expect(summary.decisions).toEqual({ mfa: ["authenticator", "sms"] });
      expect(summary.remaining).not.toContain("mfa");
    });

    test("--factors may be repeated", async () => {
      await run(["mfa"], { factors: ["authenticator", "backup-code"], yes: true, json: true });
      expect((JSON.parse(captured.out) as FixSummary).decisions.mfa).toEqual([
        "authenticator",
        "backup-code",
      ]);
    });

    test("rejects an unknown factor", async () => {
      await expect(run(["mfa"], { factors: ["totp"], yes: true })).rejects.toThrow(
        "Unknown --factors value for mfa: totp. Choose from authenticator, backup-code, sms.",
      );
      expect(patches()).toHaveLength(0);
    });

    test("agent mode without --factors is a usage error with the suggested command", async () => {
      process.env.CLERK_MODE = "agent";
      let error: unknown;
      await run(["mfa"], { yes: true }).catch((e) => (error = e));
      const { message, examples } = error as {
        message: string;
        examples: Array<{ command: string }>;
      };
      expect(message).toContain("mfa needs --factors (authenticator, backup-code, sms)");
      expect(examples[0]!.command).toBe(
        "clerk security fix mfa --factors authenticator,backup-code --app app_1 --instance ins_dev --yes",
      );
      expect(patches()).toHaveLength(0);
    });

    test("human mode asks for the factors, preselecting the suggestion", async () => {
      await run(["mfa"], { yes: true, json: true });
      expect(patches()[0]!.body).toEqual({
        auth_multi_factor: { authenticator_app: { enabled: true }, backup_code: { enabled: true } },
      });
    });

    test("--strategy applies a single passwordless method", async () => {
      await run(["passwordless-auth"], { strategy: "passkey", yes: true, json: true });
      expect(patches()[0]!.body).toEqual({ auth_passkey: { used_for_sign_in: true } });
    });

    test("human mode asks for the strategy, defaulting to an identifier already collected", async () => {
      await run(["passwordless-auth"], { yes: true, json: true });
      expect(patches()[0]!.body).toEqual({
        auth_email: { used_for_sign_in: true, sign_in_strategies: ["email_code"] },
      });
    });

    test("fixing mfa in the same call unblocks mfa-required, prerequisite first", async () => {
      await run(["mfa-required", "mfa"], { factors: ["authenticator"], yes: true, json: true });
      expect(patches()[0]!.body).toEqual({
        auth_multi_factor: { authenticator_app: { enabled: true }, required_for_sign_up: true },
      });
      const summary = JSON.parse(captured.out) as FixSummary;
      expect(summary.applied).toEqual(["mfa", "mfa-required"]);
      expect(summary.remaining).not.toContain("mfa-required");
    });

    test("--all --good-to-have with --factors includes mfa and what it unblocks", async () => {
      await run([], {
        all: true,
        goodToHave: true,
        factors: ["authenticator", "backup-code"],
        yes: true,
        json: true,
      });
      const summary = JSON.parse(captured.out) as FixSummary;
      expect(summary.applied).toContain("mfa");
      expect(summary.applied).toContain("mfa-required");
      expect(summary.remaining).toEqual([]);
      expect(summary.score.after.grade).toBe("A");
    });
  });

  describe("score line", () => {
    test("shows an arrow only when the grade changes", async () => {
      const { formatScoreTransition } = await import("./format.ts");
      const score = (grade: "C" | "B", met: number) => ({
        grade,
        percent: 0,
        met,
        total: 19,
        hasCriticalGap: true,
      });
      const strip = (s: string) => s.replace(new RegExp(String.raw`\x1b\[[0-9;]*m`, "g"), "");
      expect(strip(formatScoreTransition(score("C", 11), score("C", 13), false))).toBe(
        "Grade C · 13 of 19 recommendations met",
      );
      expect(strip(formatScoreTransition(score("C", 11), score("B", 16), true))).toBe(
        "[dry-run] projected Grade C → B · 16 of 19 recommendations met",
      );
    });
  });
});
