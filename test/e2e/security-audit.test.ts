/**
 * Live-PLAPI test for `clerk security audit`. Pins the report envelope
 * against the real config document, so a renamed config key shows up here
 * instead of silently turning a check into a permanent "unmet".
 *
 * Read-only: `--fail-on none` keeps the exit code at 0 whatever the test
 * instance's posture, and `fix` only runs under `--dry-run`, which the
 * Platform API validates without persisting, so every patch payload is
 * checked against the real schema without mutating the shared instance.
 *
 * Requires `CLERK_PLATFORM_API_KEY` and `CLERK_CLI_TEST_APP_ID`. Locally,
 * run via `bun run test:e2e:op` so 1Password resolves both in-memory.
 */

import { test, expect, afterAll, beforeAll } from "bun:test";
import { join } from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import type {
  AuditReport,
  FixSummary,
} from "../../packages/cli-core/src/commands/security/types.ts";
import { CHECK_IDS } from "../../packages/cli-core/src/commands/security/catalog.ts";

const CLI_PATH = join(import.meta.dir, "../../packages/cli-core/src/cli.ts");

let APP_ID: string;
let configDir: string;

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
  configDir = mkdtempSync(join(tmpdir(), "clerk-cli-e2e-security-"));
});

afterAll(() => {
  rmSync(configDir, { recursive: true, force: true });
});

test("security audit --json returns a graded report over the live config document", async () => {
  const result = await Bun.$`bun ${CLI_PATH} security audit --json --fail-on none --app ${APP_ID}`
    .env({ ...process.env, CLERK_CONFIG_DIR: configDir, CLERK_TELEMETRY_DISABLED: "1" })
    .quiet();

  const report = JSON.parse(result.stdout.toString()) as AuditReport;
  expect(report.instance.appId).toBe(APP_ID);
  expect(report.instance.environmentType).toBe("development");
  expect(["A", "B", "C", "D", "F"]).toContain(report.score.grade);
  expect(report.score.total).toBe(report.findings.length);
  expect(report.findings.length).toBeGreaterThan(0);

  for (const finding of report.findings) {
    expect(CHECK_IDS).toContain(finding.id);
    expect(["met", "unmet", "blocked"]).toContain(finding.status);
    expect(finding.dashboardUrl).toContain(
      `/apps/${APP_ID}/instances/${report.instance.instanceId}/`,
    );
  }
  // Every fixable gap advertises the patch an agent would apply.
  for (const finding of report.findings.filter((f) => f.status === "unmet")) {
    expect(finding.patch !== null || finding.remedy.length > 0).toBe(true);
  }
});

test("security fix --all --dry-run validates every fixable patch server-side", async () => {
  const result = await Bun.$`bun ${CLI_PATH} security fix --all --dry-run --json --app ${APP_ID}`
    .env({ ...process.env, CLERK_CONFIG_DIR: configDir, CLERK_TELEMETRY_DISABLED: "1" })
    .quiet();

  const summary = JSON.parse(result.stdout.toString()) as FixSummary;
  expect(summary.dryRun).toBe(true);
  expect(summary.score.after.total).toBe(summary.score.before.total);
  expect(summary.score.after.met).toBeGreaterThanOrEqual(summary.score.before.met);
  if (summary.changed) {
    expect(summary.applied.length).toBeGreaterThan(0);
    for (const id of summary.applied) expect(summary.remaining).not.toContain(id);
  }
});
