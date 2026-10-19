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

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { rm } from "node:fs/promises";
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
const CLAIM_TOKEN = "claim_token_for_app_a";
const TELEMETRY_URL = "https://test-telemetry.clerk.com/v1/event";

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

/** Runs once when the browser sign-in checks the account's apps, then clears itself. */
let duringSignIn: (() => Promise<void>) | undefined;
/** Runs once while the claim request is in flight, then clears itself. */
let duringClaim: (() => Promise<void>) | undefined;

beforeEach(async () => {
  // The question names the app the way the claim will: by the project's name.
  await Bun.write(join(h.tempDir, "package.json"), JSON.stringify({ name: "my-app" }));
  await writeTokenFile(CLAIM_TOKEN);
  duringSignIn = undefined;
  duringClaim = undefined;
  http.stub(async (url, init) => {
    if (url.startsWith(TELEMETRY_URL)) return Response.json({});
    if (url.endsWith(CLAIM_PATH) && init?.method === "POST") {
      await takeHook("claim")?.();
      return Response.json(APP_A);
    }
    if (url.includes(`/v1/platform/applications/${APP_A.application_id}`)) {
      return Response.json(APP_A);
    }
    // The browser sign-in lists the account's apps (to create a first one if
    // there are none) after the sign-in completes and before any claim.
    if (new URL(url).pathname === "/v1/platform/applications") {
      await takeHook("sign-in")?.();
      return Response.json([APP_B]);
    }
    return Response.json({ errors: [{ message: `unexpected ${url}` }] }, { status: 404 });
  });
});

function takeHook(which: "sign-in" | "claim") {
  const hook = which === "sign-in" ? duringSignIn : duringClaim;
  if (which === "sign-in") duringSignIn = undefined;
  else duringClaim = undefined;
  return hook;
}

const TOKEN_FILE = () => join(h.tempDir, ".clerk", "keyless.json");

async function writeTokenFile(claimToken: string) {
  await Bun.write(
    TOKEN_FILE(),
    JSON.stringify({ claimToken, createdAt: new Date().toISOString() }),
  );
}

/** A stored session `clerk auth login` recognizes: a token, and the account it belongs to. */
async function useStoredSession() {
  const { setAuth } = await import("../../lib/config.ts");
  await setAuth({ userId: "user_123" });
}

function claimRequests() {
  return http.requests.filter((r) => r.method === "POST" && r.url.endsWith(CLAIM_PATH));
}

async function tokenFileExists(): Promise<boolean> {
  return Bun.file(TOKEN_FILE()).exists();
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

test("API key only, No: signs in without claiming, and the app stays unclaimed with its token kept", async () => {
  mockState.storedToken = null;
  mockPrompts.confirm(false);

  const result = await clerk("auth", "login");

  expect(result.exitCode).toBe(0);
  expect(openedUrls).toHaveLength(1);
  expect(claimRequests()).toHaveLength(0);
  expect(await tokenFileExists()).toBe(true);
  expect(result.stderr).toContain("`my-app` is still unclaimed");
  expect(result.stderr).toContain("Claims go to the workspace your");
});

test("signed out, No: the sign-in stands, and the app stays unclaimed with its token kept", async () => {
  delete process.env.CLERK_PLATFORM_API_KEY;
  mockState.storedToken = null;
  mockPrompts.confirm(false);

  const result = await clerk("auth", "login");

  expect(result.exitCode).toBe(0);
  expect(openedUrls).toHaveLength(1);
  expect(claimRequests()).toHaveLength(0);
  expect(await tokenFileExists()).toBe(true);
  expect(result.stderr).toContain("`my-app` is still unclaimed");
});

// Login reads the token once, at the start. A token that appears later (a
// signed-out `clerk init` in another terminal) is never claimed by this run,
// asked about or not: it waits for the next login.
test.each([
  { who: "a person", args: ["auth", "login"] },
  { who: "a person with -y", args: ["auth", "login", "-y"] },
  { who: "an agent", args: ["--mode", "agent", "auth", "login"] },
])(
  "signed out, $who: a token that appears during the browser sign-in waits for the next run",
  async ({ args }) => {
    delete process.env.CLERK_PLATFORM_API_KEY;
    mockState.storedToken = null;
    await rm(TOKEN_FILE());
    duringSignIn = () => writeTokenFile(CLAIM_TOKEN);

    const result = await clerk(...args);

    expect(result.exitCode).toBe(0);
    expect(duringSignIn).toBeUndefined();
    expect(claimRequests()).toHaveLength(0);
    expect(await tokenFileExists()).toBe(true);
  },
);

// The claim redeems the token read at the start and deletes the token file
// only while it still holds that token: a replacement written meanwhile is
// another app's, which the next login asks about.
test.each([
  { who: "a person who answers Yes", args: ["auth", "login"], answers: [true] },
  { who: "an agent", args: ["--mode", "agent", "auth", "login"], answers: [] },
])(
  "stored session only, $who: a token written while the claim request runs stays on disk",
  async ({ args, answers }) => {
    delete process.env.CLERK_PLATFORM_API_KEY;
    await useStoredSession();
    mockPrompts.confirm(...answers);
    duringClaim = () => writeTokenFile("claim_token_written_meanwhile");

    const result = await clerk(...args);

    expect(result.exitCode).toBe(0);
    expect(claimRequests()).toHaveLength(1);
    expect(JSON.parse(claimRequests()[0]!.body!).token).toBe(CLAIM_TOKEN);
    expect(await Bun.file(TOKEN_FILE()).text()).toContain("claim_token_written_meanwhile");
  },
);

// Declining before anything happened is a user abort; declining after a
// sign-in keeps the sign-in, so the login succeeded. Both exit 0.
describe("what telemetry records for a No", () => {
  const TELEMETRY_ENV = ["CLERK_TELEMETRY_URL", "CLERK_TELEMETRY_DISABLED", "DO_NOT_TRACK"];

  beforeEach(async () => {
    for (const name of TELEMETRY_ENV) delete process.env[name];
    // The run that first shows the telemetry notice sends nothing.
    const { markTelemetryNoticeShown } = await import("../../lib/config.ts");
    await markTelemetryNoticeShown();
    process.env.CLERK_TELEMETRY_URL = TELEMETRY_URL;
  });

  afterEach(() => {
    for (const name of TELEMETRY_ENV) delete process.env[name];
  });

  function loginEvent() {
    const events = http.requests
      .filter((r) => r.url.startsWith(TELEMETRY_URL))
      .flatMap((r) => (JSON.parse(r.body ?? "{}") as { events: Record<string, any>[] }).events);
    expect(events).toHaveLength(1);
    return events[0]!.payload as { outcome: string; exit_code: number };
  }

  test("stored session and API key, No before any sign-in: outcome abort, exit 0", async () => {
    await useStoredSession();
    mockPrompts.confirm(false);

    await clerk("auth", "login");

    expect(loginEvent()).toMatchObject({ outcome: "abort", exit_code: 0 });
  });

  test("stored session only, No then No after a sign-in: outcome success, exit 0", async () => {
    delete process.env.CLERK_PLATFORM_API_KEY;
    await useStoredSession();
    mockPrompts.confirm(false, false);

    await clerk("auth", "login");

    expect(loginEvent()).toMatchObject({ outcome: "success", exit_code: 0 });
  });
});
