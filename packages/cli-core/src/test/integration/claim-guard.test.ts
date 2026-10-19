/**
 * A claim never relinks a folder or overwrites its keys unless the folder's
 * keys belong to the claimed app, or it has none.
 *
 * Each test starts with an init token (`.clerk/keyless.json`) for app A, the
 * app `clerk init` created signed out, and has an agent run `clerk auth login`
 * while signed in, which claims A without a prompt.
 *
 * Credential: a stored session only. CLERK_PLATFORM_API_KEY is removed, so the
 * claim and every other Platform API call use the session.
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import { join } from "node:path";
import type { Application } from "../../lib/plapi.ts";
import {
  clerk,
  http,
  publishableKeyFor,
  readConfig,
  setProfile,
  useIntegrationTestHarness,
} from "./lib/harness.ts";

const h = useIntegrationTestHarness();

const PROFILE_KEY = "github.com/test/project";
const CLAIM_PATH = "/v1/platform/accountless_applications/claim";
const CLAIM_TOKEN = "claim_token_for_app_a";

/** The unclaimed app `clerk init` created; the claim moves it into the account. */
const APP_A: Application = {
  application_id: "app_A",
  name: "init-app",
  instances: [
    {
      instance_id: "ins_dev_a",
      environment_type: "development",
      publishable_key: publishableKeyFor("init-app-a.clerk.accounts.dev"),
      secret_key: "sk_test_init_app_a",
    },
  ],
};

/** An app already in the account, which the folder may be linked to. */
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

function envFileFor(app: Application): string {
  const dev = app.instances.find((i) => i.environment_type === "development")!;
  return `CLERK_PUBLISHABLE_KEY=${dev.publishable_key}\nCLERK_SECRET_KEY=${dev.secret_key}\n`;
}

/** Keys pasted from the Dashboard, for an app that has nothing to do with A. */
const PASTED_ENV = [
  `CLERK_PUBLISHABLE_KEY=${publishableKeyFor("pasted-app.clerk.accounts.dev")}`,
  "CLERK_SECRET_KEY=sk_test_pasted_from_dashboard",
  "",
].join("\n");

// The env var outranks the folder's files as a source of its keys, so a value
// exported in the developer's or CI's shell would change what the folder holds.
const SHELL_KEY_NAMES = ["CLERK_PUBLISHABLE_KEY", "CLERK_SECRET_KEY"] as const;
const shellKeys = new Map<string, string | undefined>();

afterEach(() => {
  for (const [name, value] of shellKeys) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  shellKeys.clear();
});

beforeEach(async () => {
  for (const name of SHELL_KEY_NAMES) {
    shellKeys.set(name, process.env[name]);
    delete process.env[name];
  }
  delete process.env.CLERK_PLATFORM_API_KEY;
  // `clerk auth login` treats the folder as signed in only when the config
  // records who signed in, on top of a stored session (`getExistingSession`).
  const { setAuth } = await import("../../lib/config.ts");
  await setAuth({ userId: "user_123" });
  await Bun.write(
    join(h.tempDir, ".clerk", "keyless.json"),
    JSON.stringify({ claimToken: CLAIM_TOKEN, createdAt: new Date().toISOString() }),
  );
  // A stub rather than route mocks: an unchanged folder makes no app fetch,
  // and the same file must also run against code that does.
  http.stub(async (url, init) => {
    if (url.endsWith(CLAIM_PATH) && init?.method === "POST") return Response.json(APP_A);
    if (url.includes(`/v1/platform/applications/${APP_A.application_id}`)) {
      return Response.json(APP_A);
    }
    return Response.json({ errors: [{ message: `unexpected ${url}` }] }, { status: 404 });
  });
});

function claimRequests() {
  return http.requests.filter((r) => r.method === "POST" && r.url.endsWith(CLAIM_PATH));
}

async function tokenFileExists(): Promise<boolean> {
  return Bun.file(join(h.tempDir, ".clerk", "keyless.json")).exists();
}

async function readEnv(): Promise<string> {
  return Bun.file(join(h.tempDir, ".env")).text();
}

test("a folder linked to another app keeps its link and keys after a leftover token is claimed", async () => {
  await setProfile(PROFILE_KEY, {
    workspaceId: "",
    appId: APP_B.application_id,
    appName: APP_B.name,
    instances: { development: "ins_dev_b" },
  });
  const envBefore = envFileFor(APP_B);
  await Bun.write(join(h.tempDir, ".env"), envBefore);

  const result = await clerk("--mode", "agent", "auth", "login");

  expect(claimRequests()).toHaveLength(1);
  expect(JSON.parse(claimRequests()[0]!.body!).token).toBe(CLAIM_TOKEN);
  expect((await readConfig()).profiles[PROFILE_KEY]?.appId).toBe(APP_B.application_id);
  expect(await readEnv()).toBe(envBefore);
  expect(await tokenFileExists()).toBe(false);
  expect(result.stderr).toContain("Claimed application: `init-app`");
  expect(result.stderr).toContain("left alone");
  expect(result.stderr).toContain("clerk link --app app_A");
});

test("Dashboard keys pasted into .env stay in place after a leftover token is claimed", async () => {
  await Bun.write(join(h.tempDir, ".env"), PASTED_ENV);

  const result = await clerk("--mode", "agent", "auth", "login");

  expect(claimRequests()).toHaveLength(1);
  expect(await readEnv()).toBe(PASTED_ENV);
  expect((await readConfig()).profiles[PROFILE_KEY]).toBeUndefined();
  expect(await tokenFileExists()).toBe(false);
  expect(result.stderr).toContain("Claimed application: `init-app`");
  expect(result.stderr).toContain("belongs to a different application");
});

// Control: the guard must not block the case the claim exists for.
test("a folder holding the keys `clerk init` wrote is linked to the claimed app", async () => {
  await Bun.write(join(h.tempDir, ".env"), envFileFor(APP_A));

  const result = await clerk("--mode", "agent", "auth", "login");

  expect(claimRequests()).toHaveLength(1);
  expect((await readConfig()).profiles[PROFILE_KEY]?.appId).toBe(APP_A.application_id);
  expect(await readEnv()).toContain(`CLERK_SECRET_KEY=${APP_A.instances[0]!.secret_key}`);
  expect(await tokenFileExists()).toBe(false);
  expect(result.stderr).toContain("Claimed and linked application: `init-app`");
});
