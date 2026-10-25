/**
 * The not-linked messages outside `deploy` and `doctor` give the step for what
 * the folder holds, from the unlinked-folder module, so the same folder gets
 * the same advice from every command: the not-linked error account commands
 * share (run here through `clerk env pull`), `clerk open`, the "covers fewer
 * settings" warning (through `clerk config pull`), and `whoami`.
 *
 * Each test names its credential; the harness sets both a stored session and
 * CLERK_PLATFORM_API_KEY by default. Every run goes through `run`, which fails
 * the test if a secret key or claim token from the folder reaches the output.
 */

import { beforeEach, describe, expect, spyOn, test } from "bun:test";
import { join } from "node:path";
import type { Example } from "../../lib/help.ts";
import * as unlinkedFolder from "../../lib/unlinked-folder.ts";
import {
  clerk,
  http,
  mockState,
  openedUrls,
  publishableKeyFor,
  useIntegrationTestHarness,
  type CLIResult,
} from "./lib/harness.ts";
import { useCleanClerkKeyEnv, useSyntheticShellClerkKeys } from "../lib/clerk-key-env.ts";

const h = useIntegrationTestHarness();

useSyntheticShellClerkKeys();
useCleanClerkKeyEnv();

const SECRET_KEY = "sk_test_folder_app";
const INIT_CLAIM_TOKEN = "claim_token_init";
const SDK_CLAIM_TOKEN = "claim_token_sdk";
const PUBLISHABLE_KEY = `CLERK_PUBLISHABLE_KEY=${publishableKeyFor("folder-app.clerk.accounts.dev")}\n`;
const KEYS = `${PUBLISHABLE_KEY}CLERK_SECRET_KEY=${SECRET_KEY}\n`;
const CLAIM_IT = "Run `clerk link`: it claims the app into your account and links this folder.";
const FIND_BY_KEY = "Run `clerk link`: it finds the app in your account by that key.";

const write = (file: string, content: string) => Bun.write(join(h.tempDir, file), content);

/** An init token, which the CLI reads only with both fields. */
const writeInitToken = () =>
  write(
    ".clerk/keyless.json",
    JSON.stringify({ claimToken: INIT_CLAIM_TOKEN, createdAt: new Date().toISOString() }),
  );

/** An SDK keyless file with a working claim link and no secret key. */
const writeClaimableSdkFile = () =>
  write(
    ".clerk/.tmp/keyless.json",
    JSON.stringify({
      publishableKey: publishableKeyFor("sdk-app.clerk.accounts.dev"),
      claimUrl: `https://dashboard.clerk.com/apps/claim?token=${SDK_CLAIM_TOKEN}`,
    }),
  );

function signOut(): void {
  delete process.env.CLERK_PLATFORM_API_KEY;
  mockState.storedToken = null;
}

/** Runs the CLI and fails if a secret from the folder is in what it printed. */
async function run(...args: string[]): Promise<CLIResult> {
  const result = await clerk.raw(...args);
  const printed = `${result.stdout}\n${result.stderr}`;
  expect(printed).not.toContain(SECRET_KEY);
  expect(printed).not.toContain(INIT_CLAIM_TOKEN);
  expect(printed).not.toContain(SDK_CLAIM_TOKEN);
  return result;
}

function agentError(result: CLIResult): { code: string; message: string; examples?: Example[] } {
  return (JSON.parse(result.stderr) as { error: { code: string; message: string } }).error;
}

const commands = (examples: Example[] | undefined) => (examples ?? []).map((e) => e.command);

/** What a person reads on stderr: `log` colors backticked words. */
const stderr = (result: CLIResult) => Bun.stripANSI(result.stderr);

beforeEach(async () => {
  await write("package.json", JSON.stringify({ name: "my-app" }));
  http.stub(async (url) => {
    const { pathname } = new URL(url);
    if (pathname === "/v1/instance") {
      return Response.json({ id: "ins_folder", environment_type: "development" });
    }
    return Response.json({ errors: [{ message: `unexpected ${url}` }] }, { status: 404 });
  });
});

describe("the not-linked error account commands share", () => {
  const LEAD = "No Clerk project linked to this directory.";
  const APP_FLAG = "Or pass `--app <app_id>` to target an app directly.";

  // No app ID reaches an app that isn't in an account yet.
  test.each([
    {
      kind: "an init token",
      setUp: async () => {
        await writeInitToken();
        await write(".env", PUBLISHABLE_KEY);
      },
      step: `This folder's app was created by \`clerk init\` and isn't in an account yet. ${CLAIM_IT}`,
    },
    {
      kind: "a claimable SDK app",
      setUp: writeClaimableSdkFile,
      step: "This folder runs on an app the Clerk SDK created during development.",
    },
  ])(
    "person, stored session, $kind and no secret key: names the claim, no --app, no Examples block",
    async ({ setUp, step }) => {
      delete process.env.CLERK_PLATFORM_API_KEY;
      await setUp();

      const result = await run("env", "pull");

      expect(result.exitCode).toBe(1);
      expect(stderr(result)).toContain(`${LEAD} ${step}`);
      expect(stderr(result)).not.toContain("--app <app_id>` to target");
      expect(stderr(result)).not.toContain("Examples:");
      expect(http.requests).toEqual([]);
    },
  );

  test("person, stored session, a publishable key only: finds the app by key, then --app", async () => {
    delete process.env.CLERK_PLATFORM_API_KEY;
    await write(".env", PUBLISHABLE_KEY);

    const result = await run("env", "pull");

    expect(result.exitCode).toBe(1);
    expect(stderr(result)).toContain(`${FIND_BY_KEY}`);
    expect(stderr(result)).toContain(`\`clerk link --app <app_id>\`. ${APP_FLAG}`);
    expect(stderr(result)).not.toContain("Examples:");
  });

  test("agent, signed out, no keys: not_linked with the commands as examples, then --app", async () => {
    signOut();

    const result = await run("--mode", "agent", "env", "pull");
    const error = agentError(result);

    expect(result.exitCode).toBe(1);
    expect(error.code).toBe("not_linked");
    expect(error.message.startsWith(`${LEAD} Run \`clerk auth login\``)).toBe(true);
    expect(error.message.endsWith(APP_FLAG)).toBe(true);
    expect(commands(error.examples)).toEqual([
      "clerk auth login",
      "clerk apps list --json",
      "clerk link --app <app_id>",
      "clerk init",
    ]);
  });
});

describe("clerk open", () => {
  test("person, stored session, plain keys and no claim link: finds the app by key, never `init --accountless`", async () => {
    delete process.env.CLERK_PLATFORM_API_KEY;
    await write(".env", KEYS);

    const result = await run("open");

    expect(result.exitCode).toBe(1);
    expect(stderr(result)).toContain(
      "Found a secret key (from .env) but no claim link on disk, and this folder isn't linked, so there's no dashboard page to open.",
    );
    expect(stderr(result)).not.toContain("to open yet");
    expect(stderr(result)).toContain(FIND_BY_KEY);
    expect(stderr(result)).not.toContain("init --accountless");
    expect(stderr(result)).not.toContain("regenerate");
    expect(stderr(result)).not.toContain("Examples:");
  });

  // An SDK-created app whose claim link can't be used may already be claimed.
  test('person, stored session, an SDK file whose claim link isn\'t https: no "yet"', async () => {
    delete process.env.CLERK_PLATFORM_API_KEY;
    await write(
      ".clerk/.tmp/keyless.json",
      JSON.stringify({
        publishableKey: publishableKeyFor("sdk-app.clerk.accounts.dev"),
        secretKey: SECRET_KEY,
        claimUrl: `http://dashboard.clerk.com/apps/claim?token=${SDK_CLAIM_TOKEN}`,
      }),
    );

    const result = await run("open");

    expect(result.exitCode).toBe(1);
    expect(stderr(result)).toContain(
      "Found a secret key (from .clerk/.tmp/keyless.json) but no claim link on disk, and this folder isn't linked, so there's no dashboard page to open.",
    );
  });

  test("agent, stored session, plain keys and no claim link: not_linked with `clerk link` as the example", async () => {
    delete process.env.CLERK_PLATFORM_API_KEY;
    await write(".env", KEYS);

    const error = agentError(await run("--mode", "agent", "open"));

    expect(error.code).toBe("not_linked");
    expect(error.message).toContain(FIND_BY_KEY);
    expect(error.message).not.toContain("init --accountless");
    expect(commands(error.examples)).toEqual(["clerk link"]);
  });

  test("person, stored session, no keys: the lead stays, then the step for a folder with no app", async () => {
    delete process.env.CLERK_PLATFORM_API_KEY;

    const result = await run("open");

    expect(result.exitCode).toBe(1);
    expect(stderr(result)).toContain(
      "No Clerk project linked to this directory, and no accountless application was found either. Run `clerk link` to choose one of your apps, or `clerk init` to create one.",
    );
    expect(stderr(result)).not.toContain("Examples:");
  });

  // A subpath of an app in no account yet gets the step for what the folder
  // holds, as when there's no claim link, then the command again.
  const SUBPATH_LEAD =
    "\"users\" isn't reachable yet — this application hasn't been claimed, so it has no dashboard pages beyond the claim link.";
  const OPEN_AGAIN = "Then run `clerk open users` again.";
  const SDK_PERSON_STEP =
    "Run `clerk link`: it links the app if it's in your account, or opens the Clerk Dashboard page to claim it.";
  const SDK_AGENT_STEP = (into: string, dir: string) =>
    `Have a person claim the app into ${into}: they run \`clerk open\` in their own terminal, in this project's folder, \`${dir}\`, which opens the claim page in their browser.`;
  const CREDENTIAL_SETUP = {
    session: () => delete process.env.CLERK_PLATFORM_API_KEY,
    api_key: () => (mockState.storedToken = null),
    none: signOut,
  };
  const SUBPATH_CELLS = [
    ...(["session", "api_key"] as const).map((credential) => ({
      folder: "an init token",
      setUp: writeInitToken,
      credential,
      personSays: CLAIM_IT,
      agentSays: () => CLAIM_IT,
      examples: ["clerk link", "clerk open users"],
    })),
    {
      folder: "an init token",
      setUp: writeInitToken,
      credential: "none" as const,
      personSays: CLAIM_IT,
      agentSays: () => "Run `clerk auth login`",
      examples: ["clerk auth login", "clerk open users"],
    },
    {
      folder: "an SDK file with a working claim link",
      setUp: writeClaimableSdkFile,
      credential: "session" as const,
      personSays: SDK_PERSON_STEP,
      agentSays: (dir: string) => SDK_AGENT_STEP("the account this CLI is signed in to", dir),
      examples: ["clerk link", "clerk open users"],
    },
    {
      folder: "an SDK file with a working claim link",
      setUp: writeClaimableSdkFile,
      credential: "api_key" as const,
      personSays: SDK_PERSON_STEP,
      agentSays: (dir: string) =>
        SDK_AGENT_STEP("the workspace `CLERK_PLATFORM_API_KEY` belongs to", dir),
      examples: ["clerk link", "clerk open users"],
    },
    {
      folder: "an SDK file with a working claim link",
      setUp: writeClaimableSdkFile,
      credential: "none" as const,
      personSays: SDK_PERSON_STEP,
      agentSays: (dir: string) =>
        SDK_AGENT_STEP("the account `clerk auth login` will sign in to", dir),
      examples: ["clerk auth login", "clerk link", "clerk open users"],
    },
  ];

  test.each(SUBPATH_CELLS)(
    "person, $folder, $credential, a subpath: the folder's step, then the command again",
    async ({ setUp, credential, personSays }) => {
      await setUp();
      CREDENTIAL_SETUP[credential]();

      const result = await run("open", "users");

      expect(result.exitCode).toBe(1);
      expect(stderr(result)).toContain(`${SUBPATH_LEAD} `);
      expect(stderr(result)).toContain(personSays);
      expect(stderr(result)).toContain(OPEN_AGAIN);
      expect(stderr(result)).not.toContain("(no subpath)");
      expect(openedUrls).toEqual([]);
    },
  );

  // Run by an agent, `clerk open` prints the claim link, which carries a claim
  // token, into the agent's transcript: no example is `clerk open`.
  test.each(SUBPATH_CELLS)(
    "agent, $folder, $credential, a subpath: the folder's step for that credential, then the command again",
    async ({ setUp, credential, agentSays, examples }) => {
      await setUp();
      CREDENTIAL_SETUP[credential]();

      const error = agentError(await run("--mode", "agent", "open", "users"));

      expect(error.code).toBe("not_linked");
      expect(error.message).toStartWith(`${SUBPATH_LEAD} `);
      expect(error.message).toContain(agentSays(h.tempDir));
      expect(error.message).toEndWith(OPEN_AGAIN);
      expect(error.message).not.toContain("(no subpath)");
      expect(commands(error.examples)).toEqual(examples);
    },
  );
});

describe("the covers-fewer-settings warning", () => {
  beforeEach(() => {
    delete process.env.CLERK_PLATFORM_API_KEY;
    http.stub(async () => Response.json({}));
  });

  test("stored session, an init token and its keys: names `clerk link` as the claim step", async () => {
    await writeInitToken();
    await write(".env", KEYS);

    const result = await run("config", "pull");

    expect(stderr(result)).toContain(
      "This directory isn't linked to an application — using the secret key from .env, which covers fewer settings.",
    );
    expect(stderr(result)).toContain(CLAIM_IT);
    expect(stderr(result)).not.toContain("--app <app_id>) to use the full configuration");
  });

  test("stored session, plain keys: finds the app by key", async () => {
    await write(".env", KEYS);

    const result = await run("config", "pull");

    expect(stderr(result)).toContain("covers fewer settings");
    expect(stderr(result)).toContain(FIND_BY_KEY);
  });
});

// The shared not-linked error's step, and its rule that `--app` can't reach an
// app that isn't in an account yet; still a usage error, exit 2.
describe("clerk api --fapi", () => {
  const LEAD = "No Clerk project linked to this directory.";
  const APP_FLAG = "Or pass `--app <app_id>` to target an app directly.";

  test.each([
    {
      kind: "an init token",
      setUp: async () => {
        await writeInitToken();
        await write(".env", PUBLISHABLE_KEY);
      },
      step: CLAIM_IT,
      appFlag: false,
    },
    {
      kind: "a claimable SDK app",
      setUp: writeClaimableSdkFile,
      step: "This folder runs on an app the Clerk SDK created during development.",
      appFlag: false,
    },
    { kind: "plain keys", setUp: () => write(".env", KEYS), step: FIND_BY_KEY, appFlag: true },
    {
      kind: "no app",
      setUp: async () => {},
      step: "Run `clerk apps list --json`, then `clerk link --app <app_id>`",
      appFlag: true,
    },
  ])(
    "agent, stored session and API key, $kind: the folder's step, reading the folder once",
    async ({ setUp, step, appFlag }) => {
      await setUp();
      const reads = spyOn(unlinkedFolder, "readUnlinkedFolder");
      try {
        const result = await run("--mode", "agent", "api", "--fapi", "/environment");
        const error = agentError(result);

        expect(result.exitCode).toBe(2);
        expect(error.code).toBe("not_linked");
        expect(error.message).toStartWith(LEAD);
        expect(error.message).toContain(step);
        expect(error.message.endsWith(APP_FLAG)).toBe(appFlag);
        expect(error.examples?.length).toBeGreaterThan(0);
        expect(reads).toHaveBeenCalledTimes(1);
      } finally {
        reads.mockRestore();
      }
    },
  );
});

// With no secret key anywhere, `clerk api` gives the shared not-linked step,
// still as its usage error: exit 2, `no_secret_key`.
describe("clerk api, no secret key", () => {
  test.each([
    {
      kind: "an init token and its publishable key",
      setUp: async () => {
        await writeInitToken();
        await write(".env", PUBLISHABLE_KEY);
      },
      step: CLAIM_IT,
      appFlag: false,
    },
    {
      kind: "a publishable key only",
      setUp: () => write(".env", PUBLISHABLE_KEY),
      step: FIND_BY_KEY,
      appFlag: true,
    },
  ])(
    "agent, stored session and API key, $kind: the folder's step",
    async ({ setUp, step, appFlag }) => {
      await setUp();

      const result = await run("--mode", "agent", "api", "/users");
      const error = agentError(result);

      expect(result.exitCode).toBe(2);
      expect(error.code).toBe("no_secret_key");
      expect(error.message).toStartWith("No Clerk project linked to this directory.");
      expect(error.message).toContain(step);
      expect(error.message.includes("--app <app_id>` to target")).toBe(appFlag);
      expect(error.examples?.length).toBeGreaterThan(0);
    },
  );
});

// Plain keys may belong to an app already in an account.
describe("whoami, signed out, with a secret key on disk", () => {
  test("plain keys: says the folder uses the key and isn't linked, with `clerk link`'s step", async () => {
    signOut();
    await write(".env", KEYS);

    const result = await run("whoami");

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("ins_folder");
    expect(stderr(result)).toContain(
      "Not logged in — this folder uses the secret key from `.env` and isn't linked",
    );
    expect(stderr(result)).toContain(FIND_BY_KEY);
    expect(stderr(result)).not.toContain("unclaimed");
    expect(stderr(result)).not.toContain("clerk open");
  });

  test("an init token: still unclaimed, with the claim step", async () => {
    signOut();
    await writeInitToken();
    await write(".env", KEYS);

    const result = await run("whoami");

    expect(result.exitCode).toBe(0);
    expect(stderr(result)).toContain("running on an unclaimed accountless application");
    expect(stderr(result)).toContain(CLAIM_IT);
    expect(stderr(result)).not.toContain("clerk open");
  });
});
