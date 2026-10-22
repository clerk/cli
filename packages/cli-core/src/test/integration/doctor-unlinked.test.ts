/**
 * `clerk doctor` in a folder with no linked app and a secret key on disk:
 * the two `doctor` rows of the plan's state table that verifiers ran. Its
 * checks give the step for what the folder holds, from the unlinked-folder
 * module, and keep their statuses and fix labels.
 *
 * Each test names its credential; the harness sets both a stored session and
 * CLERK_PLATFORM_API_KEY by default.
 */

import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { join } from "node:path";
import * as localKeys from "../../lib/local-keys.ts";
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

async function doctorChecks(modeArgs: readonly string[] = []): Promise<Record<string, Check>> {
  const result = await clerk.raw(...modeArgs, "doctor", "--json");
  const checks = JSON.parse(result.stdout) as Check[];
  return Object.fromEntries(checks.map((check) => [check.name, check]));
}

/** Signed out, with keys pasted from the Dashboard in `.env`. */
async function signedOutWithDashboardKeys(): Promise<void> {
  delete process.env.CLERK_PLATFORM_API_KEY;
  mockState.storedToken = null;
  await Bun.write(join(h.tempDir, ".env"), KEYS);
}

const INIT_TOKEN_FILE = [".clerk", "keyless.json"];

/** A stored session, and an init token beside the keys in `.env`. */
async function sessionWithInitToken(): Promise<void> {
  delete process.env.CLERK_PLATFORM_API_KEY;
  await Bun.write(
    join(h.tempDir, ...INIT_TOKEN_FILE),
    JSON.stringify({ claimToken: "claim_token_init", createdAt: new Date().toISOString() }),
  );
  await Bun.write(join(h.tempDir, ".env"), KEYS);
}

// Keys pasted from the Dashboard may belong to an app already in an account.
test.each(["Logged in", "Project linked"])(
  "signed out, Dashboard keys in `.env`: %s passes, names the key's file, and gives `clerk link`'s step",
  async (name) => {
    await signedOutWithDashboardKeys();

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

test.each([
  [
    "Authentication valid",
    "pass",
    "No account session — not required: the secret key from `.env` works",
  ],
  ["Application reachable", "warn", "Skipped (secret key from `.env`, no linked app to verify)"],
  ["Instance IDs", "warn", "Skipped (secret key from `.env`, no linked instances to verify)"],
])(
  "signed out, Dashboard keys in `.env`: %s is %s and names the key's file",
  async (name, status, message) => {
    await signedOutWithDashboardKeys();

    const check = (await doctorChecks())[name]!;

    expect(check.status).toBe(status);
    expect(check.message).toBe(message);
  },
);

test("signed out, Dashboard keys in `.env`: every check runs, and none calls the app accountless or unclaimed", async () => {
  await signedOutWithDashboardKeys();

  const checks = Object.values(await doctorChecks());

  expect(checks.map((check) => check.name)).toEqual([
    "CLI version",
    "Logged in",
    "Authentication valid",
    "Project linked",
    "Application reachable",
    "Instance IDs",
    "Environment variables",
    "CLI configuration",
    "Shell completion",
    "MCP server",
  ]);
  const accountless = checks.filter((check) =>
    /accountless|unclaimed/.test(`${check.message} ${check.remedy ?? ""}`),
  );
  expect(accountless).toEqual([]);
});

test("stored session only, an init token: Project linked warns, names the claim, and keeps link's fix", async () => {
  await sessionWithInitToken();

  const linked = (await doctorChecks())["Project linked"]!;

  expect(linked.status).toBe("warn");
  expect(linked.remedy).toContain(
    "Run `clerk link`: it claims the app into your account and links this folder.",
  );
  expect(linked.fix).toBe("Link project with clerk link");
});

// With no secret key there's no keyless target, but the folder still has an
// app: the remedy is its step, as `deploy` gives it.
describe("API key only, an SDK keyless file with no secret key", () => {
  beforeEach(async () => {
    mockState.storedToken = null;
    await Bun.write(
      join(h.tempDir, ".clerk", ".tmp", "keyless.json"),
      JSON.stringify({
        publishableKey: publishableKeyFor("sdk-app.clerk.accounts.dev"),
        claimUrl: "https://dashboard.clerk.com/apps/claim?token=claim_token_sdk",
      }),
    );
  });

  test.each([
    { mode: "person", modeArgs: [], step: "Run `clerk link`" },
    { mode: "agent", modeArgs: ["--mode", "agent"], step: "Run `clerk open`" },
  ])(
    "$mode: Project linked fails, keeps link's fix, and gives the SDK app's step",
    async ({ modeArgs, step }) => {
      const linked = (await doctorChecks(modeArgs))["Project linked"]!;

      expect(linked.status).toBe("fail");
      expect(linked.fix).toBe("Link project with clerk link");
      expect(linked.remedy).toStartWith(
        `This folder runs on an app the Clerk SDK created during development. ${step}`,
      );
    },
  );
});

// `doctor` only reads: naming the claim must not claim, and reading the folder
// must not rewrite it.
test("stored session only, an init token: doctor only reads Clerk and leaves `.env` and the init token as they were", async () => {
  await sessionWithInitToken();
  const env = join(h.tempDir, ".env");
  const initToken = join(h.tempDir, ...INIT_TOKEN_FILE);
  const before = { env: await Bun.file(env).bytes(), initToken: await Bun.file(initToken).bytes() };

  await doctorChecks();

  expect(http.requests.filter((request) => request.method !== "GET")).toEqual([]);
  expect(await Bun.file(env).bytes()).toEqual(before.env);
  expect(await Bun.file(initToken).bytes()).toEqual(before.initToken);
});

// Every check that names the folder's step shares one read of each file, so a
// check that read the folder itself would read it again.
describe("a full doctor run reads the folder's keys and its init token once", () => {
  const spies: { mockRestore(): void }[] = [];

  afterEach(() => {
    for (const spy of spies.splice(0)) spy.mockRestore();
  });

  test.each([
    ["signed out, Dashboard keys in `.env`", signedOutWithDashboardKeys],
    ["stored session only, an init token", sessionWithInitToken],
  ])("%s", async (_setup, setUp) => {
    // Dynamic: keyless.ts loads a module the harness mocks.
    const keyless = await import("../../lib/keyless.ts");
    const readFolderKeys = spyOn(localKeys, "readFolderKeys");
    const peekInitToken = spyOn(keyless, "peekKeylessBreadcrumb");
    const readInitToken = spyOn(keyless, "readKeylessBreadcrumb");
    spies.push(readFolderKeys, peekInitToken, readInitToken);
    await setUp();

    await doctorChecks();

    expect(readFolderKeys).toHaveBeenCalledTimes(1);
    expect(peekInitToken).toHaveBeenCalledTimes(1);
    // Reading (not peeking) clears a malformed init token.
    expect(readInitToken).not.toHaveBeenCalled();
  });
});
