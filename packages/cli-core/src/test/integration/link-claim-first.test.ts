/**
 * `clerk link` in a folder with an init token claims that app first. The app
 * `clerk init` created isn't in any account yet, so a signed-in picker can't
 * show it, and picking another app linked the folder to the wrong one.
 *
 * Each test starts with an init token (`.clerk/keyless.json`) for app A, the
 * keys `clerk init` wrote for A in `.env`, and app B already in the account.
 * Each names its credentials; the harness sets both a stored session and
 * CLERK_PLATFORM_API_KEY by default.
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
const LIST_PATH = "/v1/platform/applications";

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

/** An app already in the account: the picker's only choice before the fix. */
const APP_B: Application = {
  application_id: "app_B",
  name: "Other App",
  instances: [
    {
      instance_id: "ins_dev_b",
      environment_type: "development",
      publishable_key: publishableKeyFor("other-app-b.clerk.accounts.dev"),
      secret_key: "sk_test_other_app_b",
    },
  ],
};

const INIT_ENV = `CLERK_PUBLISHABLE_KEY=${APP_A.instances[0]!.publishable_key}\nCLERK_SECRET_KEY=${APP_A.instances[0]!.secret_key}\n`;

useSyntheticShellClerkKeys();
useCleanClerkKeyEnv();

/** What the claim endpoint answers. */
let claimResponse: () => Response;

beforeEach(async () => {
  await Bun.write(join(h.tempDir, "package.json"), JSON.stringify({ name: "my-app" }));
  await Bun.write(
    join(h.tempDir, ".clerk", "keyless.json"),
    JSON.stringify({ claimToken: "claim_token_for_app_a", createdAt: new Date().toISOString() }),
  );
  await Bun.write(join(h.tempDir, ".env"), INIT_ENV);
  claimResponse = () => Response.json(APP_A);
  http.stub(async (url, init) => {
    const { pathname } = new URL(url);
    if (pathname === CLAIM_PATH && init?.method === "POST") return claimResponse();
    if (pathname === `${LIST_PATH}/${APP_A.application_id}`) return Response.json(APP_A);
    if (pathname === `${LIST_PATH}/${APP_B.application_id}`) return Response.json(APP_B);
    if (pathname === LIST_PATH && init?.method === "POST") {
      return Response.json({ ...APP_B, application_id: "app_created" });
    }
    if (pathname === LIST_PATH) return Response.json([APP_B]);
    return Response.json({ errors: [{ message: `unexpected ${url}` }] }, { status: 404 });
  });
});

async function useStoredSessionOnly() {
  delete process.env.CLERK_PLATFORM_API_KEY;
  const { setAuth } = await import("../../lib/config.ts");
  await setAuth({ userId: "user_123" });
}

function requests(method: string, path: string) {
  return http.requests.filter((r) => r.method === method && new URL(r.url).pathname === path);
}

async function linkedAppId(): Promise<string | undefined> {
  return (await readConfig()).profiles[PROFILE_KEY]?.appId;
}

async function tokenFileExists(): Promise<boolean> {
  return Bun.file(join(h.tempDir, ".clerk", "keyless.json")).exists();
}

test("person, stored session only, Yes: claims the init app and links it, with no picker", async () => {
  await useStoredSessionOnly();
  mockPrompts.confirm(true);

  const result = await clerk("link");

  expect(result.exitCode).toBe(0);
  expect(requests("POST", CLAIM_PATH)).toHaveLength(1);
  expect(await linkedAppId()).toBe(APP_A.application_id);
  expect(await Bun.file(join(h.tempDir, ".env")).text()).toContain(
    APP_A.instances[0]!.publishable_key,
  );
  expect(requests("GET", LIST_PATH)).toHaveLength(0);
  expect(await tokenFileExists()).toBe(false);
});

test("agent, stored session and API key: claims silently and links the init app", async () => {
  await useStoredSessionOnly();
  process.env.CLERK_PLATFORM_API_KEY = "test_platform_key";

  const result = await clerk("--mode", "agent", "link");

  expect(result.exitCode).toBe(0);
  expect(requests("POST", CLAIM_PATH)).toHaveLength(1);
  expect(await linkedAppId()).toBe(APP_A.application_id);
});

// Windows editors save CRLF line endings.
test("agent, stored session and API key, init's keys in a CRLF .env: claims and links the init app", async () => {
  await useStoredSessionOnly();
  process.env.CLERK_PLATFORM_API_KEY = "test_platform_key";
  await Bun.write(join(h.tempDir, ".env"), INIT_ENV.replaceAll("\n", "\r\n"));

  const result = await clerk.raw("--mode", "agent", "link");

  expect(result.exitCode).toBe(0);
  expect(requests("POST", CLAIM_PATH)).toHaveLength(1);
  expect(await linkedAppId()).toBe(APP_A.application_id);
});

test("person, signed out: signs in once, is asked about that account, then the claim links the init app", async () => {
  delete process.env.CLERK_PLATFORM_API_KEY;
  mockState.storedToken = null;
  // One question: link's, after the sign-in. Login's own claim stays off; a
  // second question would fail the run, since only one answer is queued.
  mockPrompts.confirm(true);

  const result = await clerk("link");

  expect(result.exitCode).toBe(0);
  expect(openedUrls).toHaveLength(1);
  expect(requests("POST", CLAIM_PATH)).toHaveLength(1);
  expect(await linkedAppId()).toBe(APP_A.application_id);
});

test("person, a claim refused by a managed workspace: stops with not_linked, no picker, no new app", async () => {
  await useStoredSessionOnly();
  mockPrompts.confirm(true);
  claimResponse = () =>
    Response.json(
      {
        errors: [
          {
            code: "accountless_application_managed_workspace",
            message: "managed",
            long_message: "This workspace is managed by an integration.",
          },
        ],
      },
      { status: 403 },
    );

  const result = await clerk.raw("link");

  expect(result.exitCode).toBe(1);
  expect(result.stderr).toContain("This folder isn't linked.");
  expect(requests("GET", LIST_PATH)).toHaveLength(0);
  expect(requests("POST", LIST_PATH)).toHaveLength(0);
  expect(await linkedAppId()).toBeUndefined();
  expect(await tokenFileExists()).toBe(true);
});

test("person, No: a user abort with nothing claimed, no picker, and the token kept", async () => {
  await useStoredSessionOnly();
  mockPrompts.confirm(false);

  const result = await clerk.raw("link");

  expect(result.exitCode).toBe(0);
  expect(requests("POST", CLAIM_PATH)).toHaveLength(0);
  expect(requests("GET", LIST_PATH)).toHaveLength(0);
  expect(await linkedAppId()).toBeUndefined();
  expect(await tokenFileExists()).toBe(true);
});
