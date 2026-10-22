/**
 * The not-linked messages outside `deploy` and `doctor` give the step for what
 * the folder holds, from the unlinked-folder module, so the same folder gets
 * the same advice from every command: the not-linked error account commands
 * share (run here through `clerk env pull`) and `clerk open`.
 *
 * Each test names its credential; the harness sets both a stored session and
 * CLERK_PLATFORM_API_KEY by default. Every run goes through `run`, which fails
 * the test if a secret key or claim token from the folder reaches the output.
 */

import { beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import type { Example } from "../../lib/help.ts";
import {
  clerk,
  http,
  mockState,
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
    expect(stderr(result)).toContain("Found a secret key (from .env) but no claim link on disk");
    expect(stderr(result)).toContain(FIND_BY_KEY);
    expect(stderr(result)).not.toContain("init --accountless");
    expect(stderr(result)).not.toContain("regenerate");
    expect(stderr(result)).not.toContain("Examples:");
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
});
