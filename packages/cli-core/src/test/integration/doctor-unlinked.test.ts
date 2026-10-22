/**
 * `clerk doctor` in a folder with no linked app and a secret key on disk:
 * the two `doctor` rows of the plan's state table that verifiers ran. Its
 * checks give the step for what the folder holds, from the unlinked-folder
 * module, and keep their statuses and fix labels.
 *
 * Each test names its credential; the harness sets both a stored session and
 * CLERK_PLATFORM_API_KEY by default.
 */

import { beforeEach, expect, test } from "bun:test";
import { join } from "node:path";
import {
  clerk,
  http,
  mockState,
  publishableKeyFor,
  useIntegrationTestHarness,
} from "./lib/harness.ts";
import { useCleanClerkKeyEnv, useSyntheticShellClerkKeys } from "../lib/clerk-key-env.ts";

const h = useIntegrationTestHarness();

useSyntheticShellClerkKeys();
useCleanClerkKeyEnv();

const KEYS = `CLERK_PUBLISHABLE_KEY=${publishableKeyFor("dashboard-app.clerk.accounts.dev")}\nCLERK_SECRET_KEY=sk_test_dashboard_app\n`;

beforeEach(async () => {
  await Bun.write(join(h.tempDir, "package.json"), JSON.stringify({ name: "my-app" }));
  http.stub(async (url) => {
    const { pathname } = new URL(url);
    if (pathname === "/v1/instance") {
      return Response.json({ id: "ins_folder", environment_type: "development" });
    }
    if (pathname === "/v1/platform/applications") return Response.json([]);
    return Response.json({ errors: [{ message: `unexpected ${url}` }] }, { status: 404 });
  });
});

type Check = { name: string; status: string; message: string; remedy?: string; fix?: string };

async function doctorChecks(): Promise<Record<string, Check>> {
  const result = await clerk.raw("doctor", "--json");
  const checks = JSON.parse(result.stdout) as Check[];
  return Object.fromEntries(checks.map((check) => [check.name, check]));
}

// Before: both checks called this "the unclaimed accountless application" and
// said to claim it from the Dashboard. Keys pasted from the Dashboard belong
// to an app that may already be in an account.
test.each(["Logged in", "Project linked"])(
  "signed out, Dashboard keys in `.env`: %s passes, names the key's file, and gives `clerk link`'s step",
  async (name) => {
    delete process.env.CLERK_PLATFORM_API_KEY;
    mockState.storedToken = null;
    await Bun.write(join(h.tempDir, ".env"), KEYS);

    const check = (await doctorChecks())[name]!;

    expect(check.status).toBe("pass");
    expect(check.message).toContain("secret key from `.env`");
    expect(check.message).toContain(
      "Run `clerk link`: it finds the app in your account by that key",
    );
    expect(check.message).not.toContain("unclaimed");
    expect(check.message).not.toContain("Claim it");
  },
);

// Before: "Run `clerk link` to use the full account configuration", which led
// to a picker that couldn't show the init app. After PR 1, `clerk link`
// claims it first.
test("stored session only, an init token: Project linked warns, names the claim, and keeps link's fix", async () => {
  delete process.env.CLERK_PLATFORM_API_KEY;
  await Bun.write(
    join(h.tempDir, ".clerk", "keyless.json"),
    JSON.stringify({ claimToken: "claim_token_init", createdAt: new Date().toISOString() }),
  );
  await Bun.write(join(h.tempDir, ".env"), KEYS);

  const linked = (await doctorChecks())["Project linked"]!;

  expect(linked.status).toBe("warn");
  expect(linked.remedy).toContain(
    "Run `clerk link`: it claims the app into your account and links this folder.",
  );
  expect(linked.fix).toBe("Link project with clerk link");
});
