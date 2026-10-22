/**
 * What a command running on the folder's secret key (no linked app) says when
 * it refuses something only a linked app can do. Only an app `clerk init` or
 * a Clerk SDK created is called unclaimed, and only an init app is claimed by
 * `clerk auth login` (for a signed-out agent, which can't run `clerk link`'s
 * browser sign-in). Plain keys may belong to an app already in an account.
 *
 * Every run goes through `run`, which fails the test if the folder's secret
 * key or claim token reaches the output.
 */

import { beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { quoteArg } from "../../lib/json-body.ts";
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
const CLAIM_TOKEN = "claim_token_init";
const PUBLISHABLE_KEY = `CLERK_PUBLISHABLE_KEY=${publishableKeyFor("folder-app.clerk.accounts.dev")}\n`;
const KEYS = `${PUBLISHABLE_KEY}CLERK_SECRET_KEY=${SECRET_KEY}\n`;

const write = (file: string, content: string) => Bun.write(join(h.tempDir, file), content);

async function run(...args: string[]): Promise<CLIResult> {
  const result = await clerk.raw(...args);
  const printed = `${result.stdout}\n${result.stderr}`;
  expect(printed).not.toContain(SECRET_KEY);
  expect(printed).not.toContain(CLAIM_TOKEN);
  return result;
}

/**
 * The refusal a person or an agent reads, and an agent's example commands. A
 * person's is the `error:` line on, after any warning printed before it.
 */
function refusal(
  result: CLIResult,
  agent: boolean,
): { text: string; examples: string[]; code?: string; exitCode: number } {
  if (!agent) {
    const stderr = Bun.stripANSI(result.stderr);
    const at = stderr.lastIndexOf("error: ");
    expect(at).toBeGreaterThan(-1);
    return { text: stderr.slice(at), examples: [], exitCode: result.exitCode };
  }
  // A warning may print before the JSON error, e.g. "covers fewer settings".
  const at = result.stderr.search(/\{\s*"error"/);
  expect(at).toBeGreaterThan(-1);
  const json = result.stderr.slice(at);
  const { error } = JSON.parse(json) as {
    error: { code: string; message: string; examples?: { command: string }[] };
  };
  return {
    text: error.message,
    examples: (error.examples ?? []).map((e) => e.command),
    code: error.code,
    exitCode: result.exitCode,
  };
}

beforeEach(() => {
  http.stub(async () => Response.json({}));
});

const FOLDERS = {
  initApp: async () => {
    await write(
      ".clerk/keyless.json",
      JSON.stringify({ claimToken: CLAIM_TOKEN, createdAt: new Date().toISOString() }),
    );
    await write(".env", KEYS);
  },
  plainKeys: () => write(".env", KEYS),
};

const CLAIM_IT = "Run `clerk link`: it claims the app into your account and links this folder.";
const AGENT_CLAIM_IT =
  "Run `clerk auth login` (it opens a browser, so a person must finish signing in): it claims the app and links this folder.";
const FIND_BY_KEY = "Run `clerk link`: it finds the app in your account by that key.";

/** Each refusal, with what it says first for an init app and for plain keys. */
const SITES = [
  {
    site: "enable billing",
    code: "auth_required",
    exitCode: 1,
    args: ["enable", "billing"],
    unclaimed:
      "Billing can only be configured on a claimed application — Clerk's Backend API has no billing settings, so an unclaimed accountless application can't reach them.",
    plain:
      "Billing can only be configured on a linked application — Clerk's Backend API has no billing settings, so the secret key from `.env` can't reach them.",
  },
  {
    site: "config schema",
    code: "auth_required",
    exitCode: 1,
    args: ["config", "schema"],
    unclaimed:
      "Config schema is only available for a claimed application — the schema describes the account-level config document, which an unclaimed accountless application has no access to.",
    plain:
      "Config schema is only available for a linked application — the schema describes the account-level config document, which the secret key from `.env` has no access to.",
  },
  {
    site: "config put",
    code: "auth_required",
    exitCode: 1,
    args: ["config", "put", "--json", "{}"],
    unclaimed:
      "Replacing the entire configuration is only available for a claimed application — an unclaimed accountless application has no full config document to replace.",
    plain:
      "Replacing the entire configuration is only available for a linked application — the secret key from `.env` has no full config document to replace.",
  },
  {
    site: "config patch, an account-only key",
    code: "usage_error",
    exitCode: 2,
    args: ["config", "patch", "--json", '{"session":{"lifetime":10}}', "--yes"],
    unclaimed: "Unsupported config key for an unclaimed accountless application: session.",
    plain: "Unsupported config key without a linked application: session.",
  },
  {
    site: "config patch, an instance field with no Backend API route",
    code: "usage_error",
    exitCode: 2,
    args: ["config", "patch", "--json", '{"instance":{"password":true}}', "--yes"],
    unclaimed:
      "Clerk's Backend API has no route for which authentication strategies are enabled, so this can't be changed from an unclaimed application at all.",
    plain:
      "Clerk's Backend API has no route for which authentication strategies are enabled, so this can't be changed without a linked application.",
  },
  {
    site: "config pull --instance",
    code: "usage_error",
    exitCode: 2,
    args: ["config", "pull", "--instance", "prod"],
    unclaimed:
      "--instance is not supported for an unclaimed accountless application: the secret key in .env already targets its own instance.",
    plain:
      "--instance is not supported without a linked application: the secret key in .env already targets its own instance.",
  },
  {
    site: "users open",
    code: "instance_not_found",
    exitCode: 1,
    args: ["users", "open", "user_123"],
    unclaimed:
      "This directory holds an unclaimed accountless application (secret key from .env), which has no Dashboard page",
    plain:
      "This directory isn't linked, so the CLI doesn't know the ID of the application the secret key from .env belongs to, and a Dashboard link needs it.",
  },
];

describe.each(SITES)("$site", ({ args, code, exitCode, unclaimed, plain }) => {
  test("person, stored session, an init token: keeps its first sentence, and `clerk link` claims", async () => {
    delete process.env.CLERK_PLATFORM_API_KEY;
    await FOLDERS.initApp();

    const result = refusal(await run(...args), false);
    const { text } = result;

    expect(result.exitCode).toBe(exitCode);
    expect(text).toContain(unclaimed);
    expect(text).toContain(CLAIM_IT);
    expect(text).not.toContain("clerk auth login");
  });

  test("agent, signed out, an init token: `clerk auth login` claims, and is the first example", async () => {
    delete process.env.CLERK_PLATFORM_API_KEY;
    mockState.storedToken = null;
    await FOLDERS.initApp();

    const result = refusal(await run("--mode", "agent", ...args), true);
    const { text, examples } = result;

    expect(result.code).toBe(code);
    expect(result.exitCode).toBe(exitCode);
    expect(text).toContain(unclaimed);
    expect(text).toContain(AGENT_CLAIM_IT);
    expect(examples[0]).toBe("clerk auth login");
  });

  test("person, stored session, plain keys: never unclaimed, finds the app by key", async () => {
    delete process.env.CLERK_PLATFORM_API_KEY;
    await FOLDERS.plainKeys();

    const result = refusal(await run(...args), false);
    const { text } = result;

    expect(result.exitCode).toBe(exitCode);
    expect(text).toContain(plain);
    expect(text).toContain(FIND_BY_KEY);
    expect(text).not.toContain("unclaimed");
    expect(text).not.toContain("clerk auth login");
  });
});

// A key name the Backend API has no route for: only the first sentence depends
// on the folder, and there's no step to give.
test.each([
  {
    kind: "an init token",
    setUp: FOLDERS.initApp,
    says: "Unsupported config key for an unclaimed accountless application: session.",
  },
  {
    kind: "plain keys",
    setUp: FOLDERS.plainKeys,
    says: "Unsupported config key without a linked application: session.",
  },
])("config pull, an unknown key, person, stored session, $kind", async ({ setUp, says }) => {
  delete process.env.CLERK_PLATFORM_API_KEY;
  await setUp();

  const result = refusal(await run("--mode", "agent", "config", "pull", "--keys", "session"), true);

  expect(result.code).toBe("usage_error");
  expect(result.exitCode).toBe(2);
  expect(result.text).toContain(says);
  expect(result.examples).toEqual([]);
  expect(result.text).not.toContain("clerk auth login");
});

// Progress lines name what the key reaches.
describe("config pull's progress line", () => {
  test.each([
    {
      kind: "an init token",
      setUp: FOLDERS.initApp,
      label: "Pulling config from this accountless application (secret key from .env)",
    },
    {
      kind: "plain keys",
      setUp: FOLDERS.plainKeys,
      label: "Pulling config from this folder's application (secret key from .env)",
    },
  ])("$kind", async ({ setUp, label }) => {
    delete process.env.CLERK_PLATFORM_API_KEY;
    await setUp();

    const text = Bun.stripANSI((await run("config", "pull")).stderr);

    expect(text).toContain(label);
  });
});

// An SDK-created app whose claim link can't be used may already be claimed:
// its step says `clerk link` links it if it's in the account.
test("enable billing, an SDK file whose claim link isn't https: not called unclaimed", async () => {
  delete process.env.CLERK_PLATFORM_API_KEY;
  await write(
    ".clerk/.tmp/keyless.json",
    JSON.stringify({
      publishableKey: publishableKeyFor("sdk-app.clerk.accounts.dev"),
      secretKey: SECRET_KEY,
      claimUrl: "http://dashboard.clerk.com/apps/claim?token=sdk_claim",
    }),
  );

  const { text } = refusal(await run("enable", "billing"), false);

  expect(text).toContain(
    "Billing can only be configured on a linked application — Clerk's Backend API has no billing settings, so the secret key from `.clerk/.tmp/keyless.json` can't reach them.",
  );
  expect(text).toContain("Run `clerk link`: it links the app if it's already in your account");
  expect(text).not.toContain("unclaimed");
});

// A rerun repeats the run's flags, shell-quoted, and never `--secret-key`.
describe("reruns keep the run's flags", () => {
  test("config schema --keys --output, agent: the rerun repeats both", async () => {
    delete process.env.CLERK_PLATFORM_API_KEY;
    await FOLDERS.plainKeys();

    const { text, examples } = refusal(
      await run(
        "--mode",
        "agent",
        "config",
        "schema",
        "--keys",
        "session",
        "sign up",
        "--output",
        "schema.json",
      ),
      true,
    );
    const rerun = `clerk config schema --keys session ${quoteArg("sign up")} --output schema.json`;

    expect(text).toContain(`Then run \`${rerun}\` again.`);
    expect(examples.at(-1)).toBe(rerun);
  });

  test("users open --print --secret-key, agent: the rerun keeps --print and never the secret key", async () => {
    delete process.env.CLERK_PLATFORM_API_KEY;
    await FOLDERS.plainKeys();

    const result = await run(
      "--mode",
      "agent",
      "users",
      "open",
      "user_123",
      "--print",
      "--secret-key",
      "sk_test_flag_secret",
    );
    const { examples } = refusal(result, true);

    expect(examples.at(-1)).toBe("clerk users open user_123 --print");
    expect(`${result.stdout}\n${result.stderr}`).not.toContain("sk_test_flag_secret");
  });
});
