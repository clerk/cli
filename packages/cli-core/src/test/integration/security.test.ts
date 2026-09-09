/**
 * `clerk security` end to end through the real program.
 * Agents get a JSON report on stdout and JSON errors on stderr.
 */

import { test, expect, beforeEach } from "bun:test";
import { INSECURE_CONFIG, SECURE_CONFIG } from "../../commands/security/fixtures.ts";
import type { AuditReport } from "../../commands/security/types.ts";
import { deepMerge } from "../../commands/security/merge.ts";
import {
  useIntegrationTestHarness,
  http,
  setProfile,
  clerk,
  getInstance,
  mockPrompts,
  MOCK_APP,
} from "./lib/harness.ts";

useIntegrationTestHarness();

const devInstance = getInstance(MOCK_APP, "development");

function serveConfig(config: Record<string, unknown>) {
  http.stub(async (url, init) => {
    if (!url.includes("/config")) return new Response("{}", { status: 404 });
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : {};
    const result = init?.method === "PATCH" ? deepMerge(config, body) : config;
    return new Response(JSON.stringify(result), { status: 200 });
  });
}

beforeEach(async () => {
  await setProfile("github.com/test/project", {
    workspaceId: "",
    appId: MOCK_APP.application_id,
    instances: { development: devInstance.instance_id },
  });
  serveConfig(INSECURE_CONFIG);
});

test("security checks lists the catalog without any request", async () => {
  const { stdout } = await clerk("--mode", "agent", "security", "checks");
  const parsed = JSON.parse(stdout) as Array<{ id: string; fixable: boolean }>;
  expect(parsed.some((c) => c.id === "user-lockout" && c.fixable)).toBe(true);
  expect(http.requests).toHaveLength(0);
});

test("security audit in agent mode exits 1 with the report on stdout and a JSON error on stderr", async () => {
  const result = await clerk.raw("--mode", "agent", "security", "audit");
  expect(result.exitCode).toBe(1);
  const report = JSON.parse(result.stdout) as AuditReport;
  expect(report.score.hasCriticalGap).toBe(true);
  expect(report.findings.length).toBeGreaterThan(0);
  const error = JSON.parse(result.stderr).error;
  expect(error.code).toBe("security_audit_failed");
  expect(http.requests.filter((r) => r.method === "GET")).toHaveLength(1);
});

test("security alone runs the audit", async () => {
  const result = await clerk.raw("--mode", "agent", "security", "--fail-on", "none");
  expect(result.exitCode).toBe(0);
  expect((JSON.parse(result.stdout) as AuditReport).findings.length).toBeGreaterThan(0);
});

test.each([{ mode: "human" }, { mode: "agent" }])(
  "security audit exits 0 on a secure instance ($mode mode)",
  async ({ mode }) => {
    serveConfig(SECURE_CONFIG);
    const result = await clerk.raw("--mode", mode, "security", "audit");
    expect(result.exitCode).toBe(0);
  },
);

test("human audit prints the grouped report on stderr", async () => {
  const result = await clerk.raw("--mode", "human", "security", "audit", "--spotlight");
  expect(result.exitCode).toBe(1);
  expect(result.stderr).toContain("Grade");
  expect(result.stderr).toContain("Critical");
  expect(result.stderr).toContain("error:");
  expect(result.stdout).toBe("");
});

test("security fix without ids exits 2 in agent mode", async () => {
  const result = await clerk.raw("--mode", "agent", "security", "fix");
  expect(result.exitCode).toBe(2);
  const error = JSON.parse(result.stderr).error;
  expect(error.code).toBe("usage_error");
  expect(error.examples).toBeDefined();
  expect(http.requests).toHaveLength(0);
});

test("security fix requires --yes in agent mode", async () => {
  const result = await clerk.raw("--mode", "agent", "security", "fix", "--all");
  expect(result.exitCode).toBe(2);
  expect(result.stderr).toContain("Pass --yes");
});

test.each([{ mode: "human" }, { mode: "agent" }])(
  "security fix --all --dry-run sends PATCH with ?dry_run=true ($mode mode)",
  async ({ mode }) => {
    const { stderr } = await clerk("--mode", mode, "security", "fix", "--all", "--dry-run");
    const patchReqs = http.requests.filter((r) => r.method === "PATCH");
    expect(patchReqs).toHaveLength(1);
    expect(patchReqs[0]!.url).toContain("dry_run=true");
    expect(stderr).toContain("[dry-run]");
  },
);

test("security fix applies the patch and reports it as JSON in agent mode", async () => {
  const { stdout } = await clerk(
    "--mode",
    "agent",
    "security",
    "fix",
    "user-lockout",
    "client-trust",
    "--yes",
  );
  const summary = JSON.parse(stdout);
  expect(summary).toMatchObject({
    changed: true,
    applied: ["user-lockout", "client-trust"],
    skipped: [],
    dryRun: false,
  });
  expect(summary.score.after.met).toBe(summary.score.before.met + 2);
  const patch = http.requests.find((r) => r.method === "PATCH")!;
  expect(JSON.parse(patch.body as string)).toEqual({
    auth_attack_protection: { user_lockout: { enabled: true } },
    auth_password: { device_trust: { enabled: true } },
  });
});

test("security fix accepts ids through --input-json", async () => {
  await clerk(
    "--mode",
    "agent",
    "security",
    "fix",
    "--input-json",
    '{"check":["user-lockout","bot-protection"],"yes":true}',
  );
  const patch = http.requests.find((r) => r.method === "PATCH")!;
  expect(Object.keys(JSON.parse(patch.body as string))).toEqual(["auth_attack_protection"]);
});

test("bare security fix in human mode applies the picked recommendations", async () => {
  mockPrompts.multiselect(["user-lockout", "bot-protection"]);
  mockPrompts.confirm(true);
  const { stderr } = await clerk("--mode", "human", "security", "fix");
  const patch = http.requests.find((r) => r.method === "PATCH")!;
  expect(JSON.parse(patch.body as string)).toEqual({
    auth_attack_protection: {
      user_lockout: { enabled: true },
      bot_protection: { captcha_enabled: true, captcha_widget_type: "smart" },
    },
  });
  expect(stderr).toContain("Applied: bot-protection, user-lockout");
  expect(stderr).toContain("Grade");
});

test("human audit rows show the id next to the title", async () => {
  const result = await clerk.raw("--mode", "human", "security", "audit", "--spotlight");
  expect(result.stderr).toContain("Brute-force lockout");
  expect(result.stderr).toContain("user-lockout");
});

test("security fix mfa --factors applies the chosen factors in agent mode", async () => {
  const { stdout } = await clerk(
    "--mode",
    "agent",
    "security",
    "fix",
    "mfa",
    "--factors",
    "authenticator,backup-code",
    "--yes",
  );
  expect(JSON.parse(stdout).decisions).toEqual({ mfa: ["authenticator", "backup-code"] });
  const patch = http.requests.find((r) => r.method === "PATCH")!;
  expect(JSON.parse(patch.body as string)).toEqual({
    auth_multi_factor: { authenticator_app: { enabled: true }, backup_code: { enabled: true } },
  });
});

test("security fix mfa without --factors exits 2 in agent mode with the suggested command", async () => {
  const result = await clerk.raw("--mode", "agent", "security", "fix", "mfa", "--yes");
  expect(result.exitCode).toBe(2);
  const error = JSON.parse(result.stderr).error;
  expect(error.message).toContain("needs --factors");
  expect(error.examples[0].command).toContain("--factors authenticator,backup-code");
  expect(http.requests.filter((r) => r.method === "PATCH")).toHaveLength(0);
});

test("security fix mfa in human mode asks which factors", async () => {
  mockPrompts.multiselect(["sms"]);
  mockPrompts.confirm(true);
  await clerk("--mode", "human", "security", "fix", "mfa");
  const patch = http.requests.find((r) => r.method === "PATCH")!;
  expect(JSON.parse(patch.body as string)).toEqual({
    auth_phone: { used_for_second_factor: true, second_factor_strategies: ["phone_code"] },
  });
});
