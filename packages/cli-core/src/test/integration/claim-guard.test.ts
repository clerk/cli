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

import { beforeEach, describe, expect, test } from "bun:test";
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
import { useCleanClerkKeyEnv, useSyntheticShellClerkKeys } from "../lib/clerk-key-env.ts";

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

// The shell outranks the folder's files as a source of its keys. A synthetic
// key under every Clerk name stands in for a developer's or CI's shell, and
// every test starts with them cleared.
useSyntheticShellClerkKeys();
useCleanClerkKeyEnv();

/** What the claim endpoint answers; a test can swap in an incomplete app. */
let claimResponse: unknown;

beforeEach(async () => {
  claimResponse = APP_A;
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
    if (url.endsWith(CLAIM_PATH) && init?.method === "POST") return Response.json(claimResponse);
    if (url.includes(`/v1/platform/applications/${APP_A.application_id}`)) {
      return Response.json(APP_A);
    }
    // App B is already in the account: `clerk link --app app_B` fetches it,
    // and the app list `clerk link` matches keys against holds it.
    if (url.includes(`/v1/platform/applications/${APP_B.application_id}`)) {
      return Response.json(APP_B);
    }
    if (new URL(url).pathname === "/v1/platform/applications") return Response.json([APP_B]);
    return Response.json({ errors: [{ message: `unexpected ${url}` }] }, { status: 404 });
  });
});

function claimRequests() {
  return http.requests.filter((r) => r.method === "POST" && r.url.endsWith(CLAIM_PATH));
}

async function tokenFileExists(): Promise<boolean> {
  return Bun.file(join(h.tempDir, ".clerk", "keyless.json")).exists();
}

async function readEnv(file = ".env"): Promise<string> {
  return Bun.file(join(h.tempDir, file)).text();
}

async function profile() {
  return (await readConfig()).profiles[PROFILE_KEY];
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
  expect(result.stderr).toContain("`CLERK_PUBLISHABLE_KEY` in .env isn't `init-app`'s");
  expect(result.stderr).toContain("it tries to match that key to an application in your account");
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

// The folder's keys can live in any file the app loads, and `env pull` writes
// to whichever of them it picks (`.env.development.local` first, in any
// framework). Every key there must belong to the claimed app before the claim
// is allowed to link the folder and write keys.
describe("keys in more than one place", () => {
  test("another app's keys only in .env.development.local stay in place", async () => {
    const before = envFileFor(APP_B);
    await Bun.write(join(h.tempDir, ".env.development.local"), before);

    const result = await clerk("--mode", "agent", "auth", "login");

    expect(claimRequests()).toHaveLength(1);
    expect(await readEnv(".env.development.local")).toBe(before);
    expect(await profile()).toBeUndefined();
    expect(await tokenFileExists()).toBe(false);
    expect(result.stderr).toContain("left alone");
  });

  test("another app's keys in .env.development.local stay in place when .env.local holds the claimed app's", async () => {
    const devLocalBefore = envFileFor(APP_B);
    const localBefore = envFileFor(APP_A);
    await Bun.write(join(h.tempDir, ".env.development.local"), devLocalBefore);
    await Bun.write(join(h.tempDir, ".env.local"), localBefore);

    const result = await clerk("--mode", "agent", "auth", "login");

    expect(await readEnv(".env.development.local")).toBe(devLocalBefore);
    expect(await readEnv(".env.local")).toBe(localBefore);
    expect(await profile()).toBeUndefined();
    expect(result.stderr).toContain("left alone");
  });

  test("another app's keys in .env stay in place when the shell exports the claimed app's", async () => {
    const dev = APP_A.instances[0]!;
    process.env.CLERK_PUBLISHABLE_KEY = dev.publishable_key;
    process.env.CLERK_SECRET_KEY = dev.secret_key;
    const before = envFileFor(APP_B);
    await Bun.write(join(h.tempDir, ".env"), before);

    const result = await clerk("--mode", "agent", "auth", "login");

    expect(await readEnv()).toBe(before);
    expect(await profile()).toBeUndefined();
    expect(result.stderr).toContain("left alone");
  });

  test("a Nuxt folder's .env keeps another app's keys when .env.local holds the claimed app's", async () => {
    // Nuxt loads only .env by default, and `env pull` writes Nuxt's keys there.
    await Bun.write(
      join(h.tempDir, "package.json"),
      JSON.stringify({ name: "nuxt-app", dependencies: { nuxt: "^3.0.0" } }),
    );
    const nuxtEnv = (app: Application) => {
      const dev = app.instances[0]!;
      return `NUXT_PUBLIC_CLERK_PUBLISHABLE_KEY=${dev.publishable_key}\nNUXT_CLERK_SECRET_KEY=${dev.secret_key}\n`;
    };
    const envBefore = nuxtEnv(APP_B);
    await Bun.write(join(h.tempDir, ".env"), envBefore);
    await Bun.write(join(h.tempDir, ".env.local"), nuxtEnv(APP_A));

    const result = await clerk("--mode", "agent", "auth", "login");

    expect(await readEnv()).toBe(envBefore);
    expect(await profile()).toBeUndefined();
    expect(result.stderr).toContain("left alone");
  });
});

// `.clerk/.tmp/keyless.json` is where a Clerk SDK keeps the keys of an app it
// created for itself. When it's there but unusable, the CLI can't tell which
// app the folder runs on, so the claim must not set the folder up.
describe("an unusable SDK keyless file", () => {
  test.each([
    { name: "can't be parsed", content: "{ half-written" },
    {
      name: "holds no key",
      content: JSON.stringify({ claimUrl: "https://dashboard.clerk.com/apps/claim?token=t" }),
    },
  ])("that $name leaves the folder alone", async ({ content }) => {
    await Bun.write(join(h.tempDir, ".clerk", ".tmp", "keyless.json"), content);

    const result = await clerk("--mode", "agent", "auth", "login");

    expect(claimRequests()).toHaveLength(1);
    expect(await profile()).toBeUndefined();
    expect(await Bun.file(join(h.tempDir, ".env.local")).exists()).toBe(false);
    expect(await Bun.file(join(h.tempDir, ".env")).exists()).toBe(false);
    expect(result.stderr).toContain("left alone");
  });
});

// The claim response normally lists the app's instances (its development and
// production environments). Linking needs them, so when they're missing the
// CLI fetches the app once and uses that copy for the check, the link, and the
// Dashboard link it prints.
describe("a claim response without instances", () => {
  beforeEach(() => {
    claimResponse = { application_id: APP_A.application_id, name: APP_A.name };
  });

  test("links a folder holding the claimed app's keys", async () => {
    await Bun.write(join(h.tempDir, ".env"), envFileFor(APP_A));

    const result = await clerk("--mode", "agent", "auth", "login");

    expect((await profile())?.appId).toBe(APP_A.application_id);
    expect(await readEnv()).toContain(`CLERK_SECRET_KEY=${APP_A.instances[0]!.secret_key}`);
    expect(result.stderr).toContain("Claimed and linked application: `init-app`");
    expect(result.stderr).toContain("/apps/app_A/instances/ins_dev_a");
  });

  test("links a folder with no keys and writes the claimed app's", async () => {
    const result = await clerk("--mode", "agent", "auth", "login");

    expect((await profile())?.appId).toBe(APP_A.application_id);
    expect(await readEnv(".env.local")).toContain(
      `CLERK_SECRET_KEY=${APP_A.instances[0]!.secret_key}`,
    );
    expect(result.stderr).toContain("Claimed and linked application: `init-app`");
  });
});

// Frameworks load env files with dotenv or Node's parser, which accept lines
// the CLI's own parser skips. A Clerk key the check can't read must make it
// answer "couldn't tell", never "no keys" or "a different app's key".
describe("key lines the CLI's env parser can't read", () => {
  const dev = (app: Application) => app.instances[0]!;

  test.each([
    {
      name: "spaces around =",
      env: (app: Application) =>
        `CLERK_PUBLISHABLE_KEY = ${dev(app).publishable_key}\nCLERK_SECRET_KEY = ${dev(app).secret_key}\n`,
    },
    {
      name: "indented lines",
      env: (app: Application) =>
        `  CLERK_PUBLISHABLE_KEY=${dev(app).publishable_key}\n  CLERK_SECRET_KEY=${dev(app).secret_key}\n`,
    },
  ])("another app's keys written with $name keep the folder unlinked", async ({ env }) => {
    const before = env(APP_B);
    await Bun.write(join(h.tempDir, ".env"), before);

    const result = await clerk("--mode", "agent", "auth", "login");

    expect(await profile()).toBeUndefined();
    expect(await readEnv()).toBe(before);
    expect(await Bun.file(join(h.tempDir, ".env.local")).exists()).toBe(false);
    expect(result.stderr).toContain("Couldn't confirm");
  });

  test("the claimed app's own key followed by a comment is 'couldn't tell', not another app's key", async () => {
    // dotenv strips the comment, so the app loads A's key; the CLI can't tell.
    await Bun.write(
      join(h.tempDir, ".env"),
      `CLERK_PUBLISHABLE_KEY=${dev(APP_A).publishable_key}\nCLERK_SECRET_KEY=${dev(APP_A).secret_key} # from clerk init\n`,
    );

    const result = await clerk("--mode", "agent", "auth", "login");

    expect(await profile()).toBeUndefined();
    expect(result.stderr).toContain("Couldn't confirm");
    expect(result.stderr).not.toContain("isn't `init-app`'s");
  });
});

// The check must read the names every supported Clerk SDK uses, not only the
// detected framework's: detection fails in a workspace package whose framework
// is declared at the workspace root.
test("another app's keys under Nuxt's names keep the folder unlinked when no framework is detected", async () => {
  const before = [
    `NUXT_PUBLIC_CLERK_PUBLISHABLE_KEY=${APP_B.instances[0]!.publishable_key}`,
    `NUXT_CLERK_SECRET_KEY=${APP_B.instances[0]!.secret_key}`,
    `CLERK_PUBLISHABLE_KEY=${APP_A.instances[0]!.publishable_key}`,
    `CLERK_SECRET_KEY=${APP_A.instances[0]!.secret_key}`,
    "",
  ].join("\n");
  await Bun.write(join(h.tempDir, ".env"), before);

  const result = await clerk("--mode", "agent", "auth", "login");

  expect(await profile()).toBeUndefined();
  expect(await readEnv()).toBe(before);
  expect(result.stderr).toContain("NUXT_");
  expect(result.stderr).toContain("left alone");
});

// Advice is tested by following it (the plan's shared rule 4): run the command
// the warning names and check where the folder ends up.
describe("following the left-alone advice", () => {
  test("another app's publishable key, folder not linked: `clerk link` links the app that key belongs to", async () => {
    await Bun.write(join(h.tempDir, ".env"), envFileFor(APP_B));
    const claim = await clerk("--mode", "agent", "auth", "login");
    expect(claim.stderr).toContain("Run `clerk link`; it tries to match that key");

    await clerk("--mode", "agent", "link");

    expect((await profile())?.appId).toBe(APP_B.application_id);
  });

  test("another app's publishable key, folder linked to the claimed app: `clerk link --app` switches it", async () => {
    await setProfile(PROFILE_KEY, {
      workspaceId: "",
      appId: APP_A.application_id,
      appName: APP_A.name,
      instances: { development: "ins_dev_a" },
    });
    await Bun.write(
      join(h.tempDir, ".env"),
      `CLERK_PUBLISHABLE_KEY=${APP_B.instances[0]!.publishable_key}\n`,
    );
    const claim = await clerk("--mode", "agent", "auth", "login");
    // Plain `clerk link` would keep the link to A, so it isn't offered.
    expect(claim.stderr).not.toContain("Run `clerk link`;");
    expect(claim.stderr).toContain("`clerk apps list --json`");

    await clerk("--mode", "agent", "link", "--app", APP_B.application_id);

    expect((await profile())?.appId).toBe(APP_B.application_id);
  });

  test("secret keys from the claimed app and another app, no publishable key: the advice never relies on plain `clerk link`", async () => {
    process.env.CLERK_SECRET_KEY = APP_A.instances[0]!.secret_key!;
    await Bun.write(
      join(h.tempDir, ".env"),
      `CLERK_SECRET_KEY=${APP_B.instances[0]!.secret_key}\n`,
    );
    const claim = await clerk("--mode", "agent", "auth", "login");
    expect(claim.stderr).toContain("Make the folder's Clerk keys belong to one application");
    expect(claim.stderr).not.toContain("Run `clerk link`;");

    await clerk("--mode", "agent", "link", "--app", APP_B.application_id);

    expect((await profile())?.appId).toBe(APP_B.application_id);
  });
});
