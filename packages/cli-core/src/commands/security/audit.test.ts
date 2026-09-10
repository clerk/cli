import { test, expect, describe, beforeEach, afterEach, spyOn, mock } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { _setConfigDir, setProfile } from "../../lib/config.ts";
import { useCaptureLog, credentialStoreStubs, gitStubs, stubFetch } from "../../test/lib/stubs.ts";
import { INSECURE_CONFIG, INSECURE_OAUTH_CONFIG, SECURE_CONFIG } from "./fixtures.ts";
import type { AuditOptions, AuditReport } from "./types.ts";

mock.module("../../lib/credential-store.ts", () => credentialStoreStubs);
mock.module("../../lib/git.ts", () => gitStubs);
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

const MOCK_APP = {
  application_id: "app_1",
  name: "My App",
  instances: [
    { instance_id: "ins_dev", environment_type: "development" },
    { instance_id: "ins_prod", environment_type: "production" },
  ],
};

describe("security audit", () => {
  const originalEnv = { ...process.env };
  const originalFetch = globalThis.fetch;
  let tempDir: string;
  let logSpy: ReturnType<typeof spyOn>;
  let errorSpy: ReturnType<typeof spyOn>;
  const captured = useCaptureLog();

  function serve(config: Record<string, unknown>) {
    stubFetch(async (input) => {
      const url = input.toString();
      if (url.includes("/config")) return new Response(JSON.stringify(config), { status: 200 });
      if (url.includes("/v1/platform/applications/app_1")) {
        return new Response(JSON.stringify(MOCK_APP), { status: 200 });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });
  }

  async function link() {
    await setProfile(process.cwd(), {
      workspaceId: "org_1",
      appId: "app_1",
      instances: { development: "ins_dev", production: "ins_prod" },
    });
  }

  async function run(options: AuditOptions = {}) {
    const { securityAudit } = await import("./audit.ts");
    return securityAudit(options);
  }

  function report(): AuditReport {
    return JSON.parse(captured.out) as AuditReport;
  }

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "clerk-security-audit-test-"));
    _setConfigDir(tempDir);
    process.env.CLERK_PLATFORM_API_KEY = "test_key";
    process.env.CLERK_PLATFORM_API_URL = "https://test-api.clerk.com";
    process.env.CLERK_MODE = "human";
    delete process.env.CLERK_SECRET_KEY;
    logSpy = spyOn(console, "log").mockImplementation(() => {});
    errorSpy = spyOn(console, "error").mockImplementation(() => {});
    serve(INSECURE_CONFIG);
  });

  afterEach(async () => {
    _setConfigDir(undefined);
    process.env = { ...originalEnv };
    globalThis.fetch = originalFetch;
    logSpy.mockRestore();
    errorSpy.mockRestore();
    await rm(tempDir, { recursive: true, force: true });
  });

  test("errors when no profile is linked", async () => {
    await expect(run()).rejects.toThrow("No Clerk project linked");
  });

  test("refuses an accountless target", async () => {
    process.env.CLERK_SECRET_KEY = "sk_test_local";
    await expect(run()).rejects.toThrow("claimed application");
  });

  test("emits the JSON envelope with --json", async () => {
    await link();
    await expect(run({ json: true })).rejects.toThrow(
      "security recommendations unmet (--fail-on critical)",
    );

    const parsed = report();
    expect(parsed.instance).toEqual({
      appId: "app_1",
      instanceId: "ins_dev",
      environmentType: "development",
      label: "app_1 (development)",
    });
    expect(parsed.score.grade).toBe("F");
    expect(parsed.score.hasCriticalGap).toBe(true);
    expect(parsed.fixCommand).toStartWith("clerk security fix ");
    expect(parsed.fixCommand).not.toContain("--yes");
    expect(parsed.fixCommand).toContain("user-lockout");
    expect(parsed.fixCommand).not.toContain("block-email-subaddresses");

    const lockout = parsed.findings.find((f) => f.id === "user-lockout")!;
    expect(lockout.status).toBe("unmet");
    expect(lockout.patch).toEqual({ auth_attack_protection: { user_lockout: { enabled: true } } });
    expect(lockout.remedy).toBe(
      "Run `clerk security fix user-lockout --app app_1 --instance ins_dev`.",
    );
    expect(lockout.dashboardUrl).toContain("/apps/app_1/instances/ins_dev/user-authentication");
    expect(lockout.docsUrl).toBe("https://clerk.com/docs/guides/secure/user-lockout");
    expect(lockout.suggestedPatch).toBeNull();

    const mfa = parsed.findings.find((f) => f.id === "mfa")!;
    expect(mfa.patch).toBeNull();
    expect(mfa.suggestedPatch).toEqual({
      auth_multi_factor: { authenticator_app: { enabled: true }, backup_code: { enabled: true } },
    });
    expect(mfa.feature).toBe("app:mfa_totp");
    expect(mfa.remedy).toContain(
      "clerk security fix mfa --factors authenticator,backup-code --app app_1 --instance ins_dev",
    );
    expect(mfa.decision?.flag).toBe("factors");
  });

  test("agent mode forces JSON, rewrites docs URLs, and adds --yes to the fix command", async () => {
    process.env.CLERK_MODE = "agent";
    await link();
    await expect(run()).rejects.toThrow();

    const parsed = report();
    expect(parsed.fixCommand).toEndWith(" --yes");
    expect(parsed.findings[0]!.docsUrl).toEndWith(".md");
    expect(captured.err).not.toContain("Grade");
  });

  test("orders findings by severity then status", async () => {
    await link();
    await expect(run({ json: true })).rejects.toThrow();
    const statuses = report().findings.map((f) => `${f.severity}:${f.status}`);
    const firstRecommended = statuses.findIndex((s) => s.startsWith("recommended"));
    expect(statuses.slice(0, firstRecommended).every((s) => s.startsWith("critical"))).toBe(true);
    const recommended = statuses.filter((s) => s.startsWith("recommended"));
    expect(recommended.indexOf("recommended:blocked")).toBeGreaterThan(
      recommended.lastIndexOf("recommended:unmet"),
    );
  });

  test("--spotlight drops met findings from JSON", async () => {
    serve(SECURE_CONFIG);
    await link();
    await run({ json: true, spotlight: true });
    expect(report().findings).toEqual([]);
    expect(report().score.grade).toBe("A");
  });

  test("renders a grouped human report", async () => {
    await link();
    await expect(run()).rejects.toThrow();
    expect(captured.err).toContain("Grade F");
    expect(captured.err).toContain("Critical");
    expect(captured.err).toContain("Brute-force lockout");
    expect(captured.err).toContain("user-lockout");
    expect(captured.err).toContain("blocked:");
    expect(captured.err).toContain("Disabled");
    expect(captured.err).toContain("(asks --factors)");
    expect(captured.err).toContain("blocked:");
    expect(captured.out).toBe("");
  });

  test("human --spotlight hides met findings", async () => {
    serve({ ...INSECURE_CONFIG, auth_password: { ...(SECURE_CONFIG.auth_password as object) } });
    await link();
    await expect(run({ spotlight: true })).rejects.toThrow();
    expect(captured.err).not.toContain("Device trust");
  });

  test.each([
    ["critical", true],
    ["recommended", true],
    ["any", true],
    ["none", false],
  ] as const)("--fail-on %s on the insecure fixture throws: %s", async (failOn, throws) => {
    await link();
    const promise = run({ json: true, failOn });
    if (throws) await expect(promise).rejects.toThrow("unmet");
    else await expect(promise).resolves.toBeUndefined();
  });

  test("--fail-on recommended passes when only good-to-have gaps remain", async () => {
    const config = {
      ...SECURE_CONFIG,
      session_settings: {
        ...(SECURE_CONFIG.session_settings as object),
        maximum_lifetime: { enabled: false, duration_seconds: 0 },
      },
    };
    serve(config);
    await link();
    await expect(run({ json: true, failOn: "recommended" })).resolves.toBeUndefined();
    await expect(run({ json: true, failOn: "any" })).rejects.toThrow(
      "1 security recommendation unmet",
    );
  });

  test("resolves the environment type for a literal instance id", async () => {
    serve(INSECURE_OAUTH_CONFIG);
    await link();
    await run({ json: true, instance: "ins_prod", failOn: "none" });
    const parsed = report();
    expect(parsed.instance.environmentType).toBe("production");
    expect(parsed.findings.some((f) => f.id === "oauth-custom-credentials")).toBe(true);
  });

  test("rejects a literal instance id the application does not own", async () => {
    await link();
    await expect(run({ json: true, instance: "ins_other", failOn: "none" })).rejects.toThrow(
      "does not belong to application app_1",
    );
  });

  test("targets an app directly with --app", async () => {
    await run({ json: true, app: "app_1", instance: "prod", failOn: "none" });
    expect(report().instance.instanceId).toBe("ins_prod");
    expect(report().fixCommand).toContain(" --app app_1 --instance ins_prod");
    for (const finding of report().findings.filter((f) => f.remedy.includes("clerk "))) {
      expect(finding.remedy).toContain(" --app app_1 --instance ins_prod");
    }
  });
});
