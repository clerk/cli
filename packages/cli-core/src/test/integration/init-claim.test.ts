/**
 * `clerk init` reruns in a folder holding an app `clerk init` created while
 * signed out (an init token in `.clerk/keyless.json`), or one a Clerk SDK
 * created for itself, link and set up that app: never a picked or newly
 * created one, and never keys written over another app's.
 *
 * Every folder is a Next.js project that already lists `@clerk/nextjs`, so
 * `init` installs nothing; `--no-skills` skips the skills prompt. Each test
 * names its credentials; the harness sets both a stored session and
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
const APPS_PATH = "/v1/platform/applications";

function app(id: string, name: string, host: string): Application {
  return {
    application_id: id,
    name,
    instances: [
      {
        instance_id: `ins_dev_${id}`,
        environment_type: "development",
        publishable_key: publishableKeyFor(host),
        secret_key: `sk_test_${id}_secret`,
      },
    ],
  };
}

/** The app `clerk init` created signed out; the claim moves it into the account. */
const APP_A = app("app_A", "my-app", "init-app-a.clerk.accounts.dev");
/** An app already in the account. */
const APP_B = app("app_B", "Other App", "other-app-b.clerk.accounts.dev");
/** An app in some other account: its keys match nothing here. */
const APP_C = app("app_C", "Pasted App", "pasted-app-c.clerk.accounts.dev");

function envFor(target: Application): string {
  const dev = target.instances[0]!;
  return `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=${dev.publishable_key}\nCLERK_SECRET_KEY=${dev.secret_key}\n`;
}

useSyntheticShellClerkKeys();
useCleanClerkKeyEnv();

let claimResponse: () => Response;

beforeEach(async () => {
  await Bun.write(
    join(h.tempDir, "package.json"),
    JSON.stringify({
      name: "my-app",
      dependencies: { next: "15.0.0", react: "19.0.0", "@clerk/nextjs": "6.0.0" },
    }),
  );
  claimResponse = () => Response.json(APP_A);
  http.stub(async (url, init) => {
    const { pathname } = new URL(url);
    if (pathname === CLAIM_PATH && init?.method === "POST") return claimResponse();
    for (const known of [APP_A, APP_B]) {
      if (pathname === `${APPS_PATH}/${known.application_id}`) return Response.json(known);
    }
    if (pathname === APPS_PATH && init?.method === "POST") {
      return Response.json(app("app_created", "my-app", "created-app.clerk.accounts.dev"));
    }
    if (pathname === APPS_PATH) return Response.json([APP_B]);
    return Response.json({ errors: [{ message: `unexpected ${url}` }] }, { status: 404 });
  });
});

async function writeInitToken() {
  await Bun.write(
    join(h.tempDir, ".clerk", "keyless.json"),
    JSON.stringify({ claimToken: "claim_token_for_app_a", createdAt: new Date().toISOString() }),
  );
}

async function useStoredSessionOnly() {
  delete process.env.CLERK_PLATFORM_API_KEY;
  const { setAuth } = await import("../../lib/config.ts");
  await setAuth({ userId: "user_123" });
}

async function useBothCredentials() {
  const { setAuth } = await import("../../lib/config.ts");
  await setAuth({ userId: "user_123" });
}

function requests(method: string, path: string) {
  return http.requests.filter((r) => r.method === method && new URL(r.url).pathname === path);
}

async function linkedAppId(): Promise<string | undefined> {
  return (await readConfig()).profiles[PROFILE_KEY]?.appId;
}

async function read(file: string): Promise<string | undefined> {
  const handle = Bun.file(join(h.tempDir, file));
  return (await handle.exists()) ? handle.text() : undefined;
}

test("agent rerun, signed in, init token: claims and links the init app, creating none", async () => {
  await useBothCredentials();
  await writeInitToken();
  await Bun.write(join(h.tempDir, ".env.local"), envFor(APP_A));

  const result = await clerk.raw("--mode", "agent", "init", "--no-skills", "-y");

  expect(result.exitCode).toBe(0);
  expect(requests("POST", CLAIM_PATH)).toHaveLength(1);
  expect(requests("POST", APPS_PATH)).toHaveLength(0);
  expect(await linkedAppId()).toBe(APP_A.application_id);
  expect(await read(".env.local")).toContain(APP_A.instances[0]!.publishable_key);
});

test("person rerun, stored session only, init token, Yes: links the init app and keeps its keys, with no picker", async () => {
  await useStoredSessionOnly();
  await writeInitToken();
  await Bun.write(join(h.tempDir, ".env.local"), envFor(APP_A));
  // The claim question; no picker answer is queued, so a picker fails the run.
  mockPrompts.confirm(true);

  const result = await clerk.raw("init", "--no-skills", "-y");

  expect(result.exitCode).toBe(0);
  expect(await linkedAppId()).toBe(APP_A.application_id);
  expect(await read(".env.local")).toContain(APP_A.instances[0]!.publishable_key);
  expect(await read(".env.local")).not.toContain(APP_B.instances[0]!.publishable_key);
});

test("agent, signed in, SDK keyless file only: stops with usage_error and creates no app", async () => {
  await useBothCredentials();
  await Bun.write(
    join(h.tempDir, ".clerk", ".tmp", "keyless.json"),
    JSON.stringify({
      publishableKey: APP_C.instances[0]!.publishable_key,
      secretKey: APP_C.instances[0]!.secret_key,
      claimUrl: "https://dashboard.clerk.com/apps/claim?token=sdk_token",
    }),
  );

  const result = await clerk.raw("--mode", "agent", "init", "--no-skills", "-y");

  expect(result.exitCode).toBe(2);
  expect(result.stderr).toContain('"code":"usage_error"');
  expect(requests("POST", APPS_PATH)).toHaveLength(0);
  expect(await linkedAppId()).toBeUndefined();
});

test("person, signed out, init token, claim refused: no picker and no new app", async () => {
  delete process.env.CLERK_PLATFORM_API_KEY;
  mockState.storedToken = null;
  await writeInitToken();
  await Bun.write(join(h.tempDir, ".env.local"), envFor(APP_A));
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
  // The claim question after the sign-in; the picker would need an answer.
  mockPrompts.confirm(true);

  const result = await clerk.raw("init", "--no-skills", "-y");

  expect(result.exitCode).toBe(1);
  expect(result.stderr).toContain("This folder isn't linked.");
  expect(requests("POST", APPS_PATH)).toHaveLength(0);
  expect(await linkedAppId()).toBeUndefined();
});

test.each([
  { token: "an init token", claim: () => Response.json(APP_A) },
  {
    token: "a stale init token",
    claim: () => Response.json({ errors: [{ message: "not found" }] }, { status: 404 }),
  },
])(
  "agent, signed in, $token, the folder holding another app's keys: no new app, keys unchanged",
  async ({ claim }) => {
    await useBothCredentials();
    await writeInitToken();
    const pasted = envFor(APP_C);
    await Bun.write(join(h.tempDir, ".env.local"), pasted);
    claimResponse = claim;

    await clerk.raw("--mode", "agent", "init", "--no-skills", "-y");

    expect(requests("POST", APPS_PATH)).toHaveLength(0);
    expect(await read(".env.local")).toBe(pasted);
    expect(await linkedAppId()).toBeUndefined();
  },
);

// The claim left the folder alone because it mixes two apps' keys; matching
// the key Next.js loads finds app B, but `.env` still holds app A's keys,
// which writing B's keys would leave pointing the folder at two apps.
test("agent, signed in, init token, keys from two apps: links nothing, writes nothing, names the other key", async () => {
  await useBothCredentials();
  await writeInitToken();
  await Bun.write(join(h.tempDir, ".env"), envFor(APP_A));
  await Bun.write(join(h.tempDir, ".env.local"), envFor(APP_B));

  const result = await clerk.raw("--mode", "agent", "init", "--no-skills", "-y");

  expect(result.exitCode).toBe(1);
  expect(result.stderr).toContain('"code":"not_linked"');
  expect(result.stderr).toContain("in .env");
  expect(await linkedAppId()).toBeUndefined();
  expect(await read(".env")).toBe(envFor(APP_A));
  expect(await read(".env.local")).toBe(envFor(APP_B));
});

test("person, signed in, SDK-only folder whose app isn't in the account: opens the claim page and stops before setup, exit 1", async () => {
  await useStoredSessionOnly();
  await Bun.write(
    join(h.tempDir, ".clerk", ".tmp", "keyless.json"),
    JSON.stringify({
      publishableKey: APP_C.instances[0]!.publishable_key,
      secretKey: APP_C.instances[0]!.secret_key,
      claimUrl: "https://dashboard.clerk.com/apps/claim?token=sdk_token",
    }),
  );

  const result = await clerk.raw("init", "--no-skills", "-y");

  expect(result.exitCode).toBe(1);
  expect(openedUrls).toEqual(["https://dashboard.clerk.com/apps/claim?token=sdk_token"]);
  // The person reruns init, which finishes setup, and is told so once.
  expect(Bun.stripANSI(result.stderr)).toContain("run `clerk init` again");
  expect(Bun.stripANSI(result.stderr)).not.toContain("run `clerk link` again");
  expect(await linkedAppId()).toBeUndefined();
  // Stopped before scaffolding and before any key write.
  expect(await read("middleware.js")).toBeUndefined();
  expect(await read(".env.local")).toBeUndefined();
});

// A claim that leaves the folder alone, or a stale token: no account app owns
// the folder's keys, so whichever app the person picks, init links nothing and
// writes nothing. (The picker's missing "Create" choice is checked in
// `link-flow.test.ts`, which can see the choices.)
test.each([
  { token: "an init token", claim: () => Response.json(APP_A) },
  {
    token: "a stale init token",
    claim: () => Response.json({ errors: [{ message: "not found" }] }, { status: 404 }),
  },
])(
  "person, stored session only, $token, keys of an app not in the account: links nothing and creates nothing",
  async ({ claim }) => {
    await useStoredSessionOnly();
    await writeInitToken();
    const pasted = envFor(APP_C);
    await Bun.write(join(h.tempDir, ".env.local"), pasted);
    claimResponse = claim;
    mockPrompts.confirm(true);
    mockPrompts.search(APP_B.application_id);

    const result = await clerk.raw("init", "--no-skills", "-y");

    expect(result.exitCode).toBe(1);
    expect(requests("POST", APPS_PATH)).toHaveLength(0);
    expect(await linkedAppId()).toBeUndefined();
    expect(await read(".env.local")).toBe(pasted);
  },
);

test("agent, signed in, the app list failing: no new app, and the folder's keys are kept", async () => {
  await useBothCredentials();
  const own = envFor(APP_B);
  await Bun.write(join(h.tempDir, ".env.local"), own);
  http.stub(async (url, init) => {
    const { pathname } = new URL(url);
    if (pathname === APPS_PATH && init?.method === "POST") {
      return Response.json(app("app_created", "my-app", "created-app.clerk.accounts.dev"));
    }
    if (pathname === APPS_PATH) {
      return Response.json({ errors: [{ message: "Internal Server Error" }] }, { status: 500 });
    }
    return Response.json({ errors: [{ message: `unexpected ${url}` }] }, { status: 404 });
  });

  const result = await clerk.raw("--mode", "agent", "init", "--no-skills", "-y");

  expect(result.exitCode).toBe(2);
  expect(result.stderr).toContain("couldn't list your applications");
  expect(requests("POST", APPS_PATH)).toHaveLength(0);
  expect(await read(".env.local")).toBe(own);
});

// The case init's every-key check exists to allow.
test("agent, signed in, a stale init token, the account app's keys: links that app and writes its keys", async () => {
  await useBothCredentials();
  await writeInitToken();
  await Bun.write(join(h.tempDir, ".env.local"), envFor(APP_B));
  claimResponse = () => Response.json({ errors: [{ message: "not found" }] }, { status: 404 });

  const result = await clerk.raw("--mode", "agent", "init", "--no-skills", "-y");

  expect(result.exitCode).toBe(0);
  expect(await linkedAppId()).toBe(APP_B.application_id);
  expect(await read(".env.local")).toContain(APP_B.instances[0]!.secret_key);
});
