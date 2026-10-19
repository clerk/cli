/**
 * A person's `clerk auth login` asks before claiming the app `clerk init`
 * created, and the question names where the claim goes. Agents claim without
 * asking.
 *
 * Each test starts with an init token (`.clerk/keyless.json`) for app A in a
 * folder with no keys, and names its credentials: CLERK_PLATFORM_API_KEY
 * decides where a claim goes whenever it's set, and the harness sets both it
 * and a stored session by default.
 */

import { beforeEach, expect, test } from "bun:test";
import { join } from "node:path";
import type { Application } from "../../lib/plapi.ts";
import {
  clerk,
  http,
  mockPrompts,
  mockState,
  openedUrls,
  publishableKeyFor,
  readConfig,
  useIntegrationTestHarness,
} from "./lib/harness.ts";
import { useCleanClerkKeyEnv, useSyntheticShellClerkKeys } from "../lib/clerk-key-env.ts";

const h = useIntegrationTestHarness();

const PROFILE_KEY = "github.com/test/project";
const CLAIM_PATH = "/v1/platform/accountless_applications/claim";

/** The unclaimed app `clerk init` created; the claim moves it into the account. */
const APP_A: Application = {
  application_id: "app_A",
  name: "my-app",
  instances: [
    {
      instance_id: "ins_dev_a",
      environment_type: "development",
      publishable_key: publishableKeyFor("init-app-a.clerk.accounts.dev"),
      secret_key: "sk_test_init_app_a",
    },
  ],
};

/** An app already in the account, so a browser sign-in creates no default app. */
const APP_B: Application = {
  application_id: "app_B",
  name: "Other App",
  instances: [],
};

// The claim's folder check reads the shell's Clerk keys; a synthetic one under
// every name stands in for a developer's shell, cleared before each test.
useSyntheticShellClerkKeys();
useCleanClerkKeyEnv();

beforeEach(async () => {
  // The question names the app the way the claim will: by the project's name.
  await Bun.write(join(h.tempDir, "package.json"), JSON.stringify({ name: "my-app" }));
  await Bun.write(
    join(h.tempDir, ".clerk", "keyless.json"),
    JSON.stringify({ claimToken: "claim_token_for_app_a", createdAt: new Date().toISOString() }),
  );
  http.stub(async (url, init) => {
    if (url.endsWith(CLAIM_PATH) && init?.method === "POST") return Response.json(APP_A);
    if (url.includes(`/v1/platform/applications/${APP_A.application_id}`)) {
      return Response.json(APP_A);
    }
    if (new URL(url).pathname === "/v1/platform/applications") return Response.json([APP_B]);
    return Response.json({ errors: [{ message: `unexpected ${url}` }] }, { status: 404 });
  });
});

/** A stored session `clerk auth login` recognizes: a token, and the account it belongs to. */
async function useStoredSession() {
  const { setAuth } = await import("../../lib/config.ts");
  await setAuth({ userId: "user_123" });
}

function claimRequests() {
  return http.requests.filter((r) => r.method === "POST" && r.url.endsWith(CLAIM_PATH));
}

async function tokenFileExists(): Promise<boolean> {
  return Bun.file(join(h.tempDir, ".clerk", "keyless.json")).exists();
}

async function profile() {
  return (await readConfig()).profiles[PROFILE_KEY];
}

test("stored session only, Yes: claims with the current session and links the folder, with no browser sign-in", async () => {
  delete process.env.CLERK_PLATFORM_API_KEY;
  await useStoredSession();
  mockPrompts.confirm(true);

  const result = await clerk("auth", "login");

  expect(result.exitCode).toBe(0);
  expect(openedUrls).toEqual([]);
  expect(claimRequests()).toHaveLength(1);
  expect((await profile())?.appId).toBe(APP_A.application_id);
  expect(await tokenFileExists()).toBe(false);
});

test("API key only, Yes: claims with the key, with no browser sign-in", async () => {
  mockState.storedToken = null;
  mockPrompts.confirm(true);

  const result = await clerk("auth", "login");

  expect(result.exitCode).toBe(0);
  expect(openedUrls).toEqual([]);
  expect(claimRequests()).toHaveLength(1);
  expect((await profile())?.appId).toBe(APP_A.application_id);
  expect(await tokenFileExists()).toBe(false);
});

test("stored session only, No then No: signs in again, and the app stays unclaimed with its token kept", async () => {
  delete process.env.CLERK_PLATFORM_API_KEY;
  await useStoredSession();
  mockPrompts.confirm(false, false);

  const result = await clerk("auth", "login");

  expect(result.exitCode).toBe(0);
  expect(openedUrls).toHaveLength(1);
  expect(claimRequests()).toHaveLength(0);
  expect(await tokenFileExists()).toBe(true);
  expect(await profile()).toBeUndefined();
  expect(result.stderr).toContain("`my-app` is still unclaimed");
});

// Control: declining before anything happened was already a clean abort.
test("stored session and API key, No: nothing is claimed and no browser sign-in runs", async () => {
  await useStoredSession();
  mockPrompts.confirm(false);

  const result = await clerk("auth", "login");

  expect(result.exitCode).toBe(0);
  expect(openedUrls).toEqual([]);
  expect(claimRequests()).toHaveLength(0);
  expect(await tokenFileExists()).toBe(true);
  expect(await profile()).toBeUndefined();
});

// Control: agents can't answer a question, so they claim as before. No answer
// is queued; a question would fail the run.
test("agent, stored session and API key: claims without asking", async () => {
  await useStoredSession();

  const result = await clerk("--mode", "agent", "auth", "login");

  expect(result.exitCode).toBe(0);
  expect(claimRequests()).toHaveLength(1);
  expect((await profile())?.appId).toBe(APP_A.application_id);
});
