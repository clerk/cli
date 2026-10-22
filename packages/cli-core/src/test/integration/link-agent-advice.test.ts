/**
 * What agent-mode `clerk link`, and `clerk init` through it, says when it
 * can't choose an application. The lead sentence and the error code stay as
 * they were; the advice after `link`'s reason comes from the unlinked-folder
 * module, with runnable `examples`, and never sends the agent back into the
 * same stop. The only exceptions are reruns of the command that stopped: the
 * retry after a list that failed for a reason other than its credential, and
 * the rerun after a refused `CLERK_PLATFORM_API_KEY` is replaced or unset.
 *
 * Each test names its credential: a stored session only, the API key only, or
 * none. The harness sets both by default.
 */

import { beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import type { Example } from "../../lib/help.ts";
import type { Application } from "../../lib/plapi.ts";
import {
  clerk,
  http,
  mockState,
  openedUrls,
  publishableKeyFor,
  readConfig,
  useIntegrationTestHarness,
  type CLIResult,
} from "./lib/harness.ts";
import { useCleanClerkKeyEnv, useSyntheticShellClerkKeys } from "../lib/clerk-key-env.ts";

const h = useIntegrationTestHarness();

const PROFILE_KEY = "github.com/test/project";
const APPS_PATH = "/v1/platform/applications";
const CLAIM_PATH = "/v1/platform/accountless_applications/claim";
const LEAD = "Cannot select an application in agent mode.";

function app(id: string, host: string): Application {
  return {
    application_id: id,
    name: id,
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

/** The app `clerk init` created; the claim moves it into the account. */
const INIT_APP = app("app_init", "init-app.clerk.accounts.dev");
/** The app a Clerk SDK created for itself; never in the account here. */
const SDK_APP = app("app_sdk", "sdk-app.clerk.accounts.dev");
/** An app in another account: its key matches nothing here. */
const STRANGER_APP = app("app_stranger", "stranger-app.clerk.accounts.dev");
/** The only app in the account. */
const OTHER_APP = app("app_other", "other-app.clerk.accounts.dev");

const pk = (target: Application) => target.instances[0]!.publishable_key;
const sk = (target: Application) => target.instances[0]!.secret_key;

useSyntheticShellClerkKeys();
useCleanClerkKeyEnv();

/** The status the app list fails with; undefined answers with the account's apps. */
let listFailure: number | undefined;

beforeEach(async () => {
  listFailure = undefined;
  await write("package.json", JSON.stringify({ name: "my-app" }));
  http.stub(async (url, init) => {
    const { pathname } = new URL(url);
    if (pathname === CLAIM_PATH && init?.method === "POST") return Response.json(INIT_APP);
    if (pathname === `${APPS_PATH}/${INIT_APP.application_id}`) return Response.json(INIT_APP);
    if (pathname === APPS_PATH && init?.method === "POST") {
      return Response.json(app("app_created", "created-app.clerk.accounts.dev"));
    }
    if (pathname === APPS_PATH) {
      return listFailure
        ? Response.json({ errors: [{ message: "list failed" }] }, { status: listFailure })
        : Response.json([OTHER_APP]);
    }
    return Response.json({ errors: [{ message: `unexpected ${url}` }] }, { status: 404 });
  });
});

async function write(file: string, content: string): Promise<void> {
  await Bun.write(join(h.tempDir, file), content);
}

const FOLDERS = {
  initApp: async () => {
    await write(
      ".clerk/keyless.json",
      JSON.stringify({ claimToken: "claim_token_init", createdAt: new Date().toISOString() }),
    );
    await write(
      ".env",
      `CLERK_PUBLISHABLE_KEY=${pk(INIT_APP)}\nCLERK_SECRET_KEY=${sk(INIT_APP)}\n`,
    );
  },
  sdkApp: async (overrides: Record<string, unknown> = {}) => {
    await write(
      ".clerk/.tmp/keyless.json",
      JSON.stringify({
        publishableKey: pk(SDK_APP),
        secretKey: sk(SDK_APP),
        claimUrl: "https://dashboard.clerk.com/apps/claim?token=sdk_claim_token",
        ...overrides,
      }),
    );
  },
  publishableKey: async () => {
    await write(
      ".env",
      `CLERK_PUBLISHABLE_KEY=${pk(STRANGER_APP)}\nCLERK_SECRET_KEY=${sk(STRANGER_APP)}\n`,
    );
  },
  secretKeyOnly: async () => {
    await write(".env", `CLERK_SECRET_KEY=${sk(STRANGER_APP)}\n`);
  },
  // No framework, so no documented order between the two files.
  couldntTell: async () => {
    await write(".env", `CLERK_PUBLISHABLE_KEY=${pk(STRANGER_APP)}\n`);
    await write(".env.local", `CLERK_PUBLISHABLE_KEY=${pk(OTHER_APP)}\n`);
  },
  none: async () => {},
};

type Credential = "session" | "api_key" | "none";

async function useCredential(credential: Credential): Promise<void> {
  if (credential !== "api_key") delete process.env.CLERK_PLATFORM_API_KEY;
  if (credential !== "session") mockState.storedToken = null;
}

type AgentError = { code: string; message: string; examples?: Example[] };

/** Agent mode prints a failure as one JSON object on stderr, after any other line. */
function agentError(result: CLIResult): AgentError {
  const line = result.stderr.split("\n").findLast((entry) => entry.startsWith('{"error"'));
  if (!line) throw new Error(`no agent error in:\n${result.stderr}`);
  return (JSON.parse(line) as { error: AgentError }).error;
}

const commands = (error: AgentError) => (error.examples ?? []).map((example) => example.command);

function occurrences(text: string, part: string): number {
  return text.split(part).length - 1;
}

async function linkedAppId(): Promise<string | undefined> {
  return (await readConfig()).profiles[PROFILE_KEY]?.appId;
}

function created(): boolean {
  return http.requests.some(
    (request) => request.method === "POST" && new URL(request.url).pathname === APPS_PATH,
  );
}

const NO_USABLE_CLAIM_LINK =
  "This folder's Clerk SDK keyless file (`.clerk/.tmp/keyless.json`) has no usable claim link";

type Cell = {
  name: string;
  credential: Credential;
  setUp: () => Promise<void>;
  listFails?: number;
  /** The commands `examples` names, in order. */
  expected: string[];
  /** Text the message holds, besides the lead. */
  says?: string[];
  /** Text the message holds exactly once. */
  saysOnce?: string;
  saysNot?: string[];
};

const STOPS: Cell[] = [
  {
    name: "an init token",
    credential: "none",
    setUp: FOLDERS.initApp,
    expected: ["clerk auth login"],
    says: ["created by `clerk init`"],
  },
  {
    name: "an SDK app not in the account",
    credential: "session",
    setUp: async () => FOLDERS.sdkApp(),
    expected: ["clerk open", "clerk link"],
    says: ["isn't in your account yet", "the account this CLI is signed in to"],
    saysNot: ["created during development"],
  },
  {
    name: "an SDK app not in the account",
    credential: "api_key",
    setUp: async () => FOLDERS.sdkApp(),
    expected: ["clerk open", "clerk link"],
    says: ["the workspace `CLERK_PLATFORM_API_KEY` belongs to"],
  },
  {
    name: "an SDK file without a publishable key",
    credential: "session",
    setUp: async () => FOLDERS.sdkApp({ publishableKey: undefined }),
    expected: ["clerk apps list --json", "clerk link --app <app_id>"],
    saysOnce: `${NO_USABLE_CLAIM_LINK}: it has no publishable key.`,
  },
  {
    name: "an SDK file without a publishable key",
    credential: "none",
    setUp: async () => FOLDERS.sdkApp({ publishableKey: undefined }),
    expected: ["clerk auth login", "clerk apps list --json", "clerk link --app <app_id>"],
    saysOnce: `${NO_USABLE_CLAIM_LINK}: it has no publishable key.`,
  },
  // Shane's decision of 2026-10-21: the token's sign-in claims the app, and
  // `link`'s reason still comes first.
  {
    name: "an SDK file without a publishable key, and an init token",
    credential: "none",
    setUp: async () => {
      await FOLDERS.sdkApp({ publishableKey: undefined });
      await write(
        ".clerk/keyless.json",
        JSON.stringify({ claimToken: "claim_token_init", createdAt: new Date().toISOString() }),
      );
    },
    expected: ["clerk auth login"],
    says: ["created by `clerk init`"],
    saysOnce: `${NO_USABLE_CLAIM_LINK}: it has no publishable key.`,
  },
  {
    name: "an SDK app not in the account, with a claim URL that isn't https",
    credential: "session",
    setUp: async () => FOLDERS.sdkApp({ claimUrl: "http://dashboard.clerk.com/apps/claim?t=x" }),
    expected: ["clerk apps list --json", "clerk link --app <app_id>"],
    saysOnce: NO_USABLE_CLAIM_LINK,
  },
  {
    name: "an SDK app",
    credential: "none",
    setUp: async () => FOLDERS.sdkApp(),
    expected: ["clerk auth login", "clerk link"],
    says: ["couldn't list your applications"],
  },
  {
    name: "a publishable key no account app uses",
    credential: "session",
    setUp: FOLDERS.publishableKey,
    expected: ["clerk apps list --json", "clerk link --app <app_id>"],
    says: ["No application in your account uses this folder's publishable key"],
  },
  {
    name: "a publishable key",
    credential: "none",
    setUp: FOLDERS.publishableKey,
    expected: ["clerk auth login", "clerk link"],
  },
  {
    name: "a secret key only",
    credential: "session",
    setUp: FOLDERS.secretKeyOnly,
    expected: ["clerk apps list --json", "clerk link --app <app_id>"],
  },
  {
    name: "keys the CLI couldn't tell apart",
    credential: "session",
    setUp: FOLDERS.couldntTell,
    expected: ["clerk apps list --json", "clerk link --app <app_id>"],
    says: ["hold different Clerk publishable keys"],
  },
  {
    name: "no keys",
    credential: "session",
    setUp: FOLDERS.none,
    expected: ["clerk apps list --json", "clerk link --app <app_id>"],
    says: ["Pass --app <id>, or run `clerk apps list --json` and retry."],
  },
  {
    name: "no keys",
    credential: "none",
    setUp: FOLDERS.none,
    expected: [
      "clerk auth login",
      "clerk apps list --json",
      "clerk link --app <app_id>",
      "clerk init",
    ],
  },
  // A refused key: signing in can't help while it's set.
  {
    name: "a publishable key, the list refusing the API key (401)",
    credential: "api_key",
    setUp: FOLDERS.publishableKey,
    listFails: 401,
    expected: ["clerk link"],
    says: ["Replace `CLERK_PLATFORM_API_KEY`"],
  },
  {
    name: "an SDK app, the list refusing the API key (401)",
    credential: "api_key",
    setUp: async () => FOLDERS.sdkApp(),
    listFails: 401,
    expected: ["clerk link"],
    says: ["Replace `CLERK_PLATFORM_API_KEY`"],
  },
  // A list that failed for another reason may pass on a retry.
  {
    name: "a publishable key, the list failing (500)",
    credential: "session",
    setUp: FOLDERS.publishableKey,
    listFails: 500,
    expected: ["clerk link", "clerk link --app <app_id>"],
    says: ["retry: run `clerk link` again", "Clerk Dashboard"],
    saysNot: ["No application in your account"],
  },
  {
    name: "an SDK app, the list failing (500)",
    credential: "session",
    setUp: async () => FOLDERS.sdkApp(),
    listFails: 500,
    expected: ["clerk link", "clerk link --app <app_id>"],
    says: ["retry: run `clerk link` again", "Clerk Dashboard"],
  },
];

describe("agent `clerk link` that can't choose an app", () => {
  test.each(STOPS)(
    "$name, $credential: usage_error, exit 2, then $expected",
    async ({ credential, setUp, listFails, expected, says = [], saysOnce, saysNot = [] }) => {
      await setUp();
      await useCredential(credential);
      listFailure = listFails;

      const result = await clerk.raw("--mode", "agent", "link");
      const error = agentError(result);

      expect(result.exitCode).toBe(2);
      expect(error.code).toBe("usage_error");
      expect(error.message.startsWith(`${LEAD} `)).toBe(true);
      expect(commands(error)).toEqual(expected);
      for (const part of says) expect(error.message).toContain(part);
      if (saysOnce) expect(occurrences(error.message, saysOnce)).toBe(1);
      for (const part of saysNot) expect(error.message).not.toContain(part);
      expect(error.message).not.toContain("://");
      expect(await linkedAppId()).toBeUndefined();
      expect(created()).toBe(false);
    },
  );

  // PR 1 claims and links it: success, not a stop.
  test.each(["session", "api_key"] as const)(
    "an init token, %s only: claims and links the init app, with no browser",
    async (credential) => {
      await FOLDERS.initApp();
      await useCredential(credential);

      const result = await clerk.raw("--mode", "agent", "link");

      expect(result.exitCode).toBe(0);
      expect(result.stderr).not.toContain('{"error"');
      expect(await linkedAppId()).toBe(INIT_APP.application_id);
      expect(openedUrls).toEqual([]);
    },
  );
});

// `init` passes its own rerun, so the advice ends with `clerk init`, never a
// bare `clerk link`, and its retry is `clerk init`.
describe("agent `clerk init` reaching `link`'s stop", () => {
  beforeEach(async () => {
    await write(
      "package.json",
      JSON.stringify({
        name: "my-app",
        dependencies: { next: "15.0.0", react: "19.0.0", "@clerk/nextjs": "6.0.0" },
      }),
    );
  });

  test.each([
    {
      name: "a Clerk line the CLI can't read",
      setUp: () =>
        write(".env.local", `  NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY = ${pk(STRANGER_APP)}\n`),
      expected: ["clerk apps list --json", "clerk link --app <app_id>", "clerk init"],
      says: "couldn't read the `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` line",
    },
    {
      name: "a publishable key, the list failing (500)",
      setUp: () =>
        write(
          ".env.local",
          `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=${pk(STRANGER_APP)}\nCLERK_SECRET_KEY=${sk(STRANGER_APP)}\n`,
        ),
      listFails: 500,
      expected: ["clerk init", "clerk link --app <app_id>", "clerk init"],
      says: "retry: run `clerk init` again",
    },
    {
      name: "an SDK app not in the account",
      setUp: () => FOLDERS.sdkApp(),
      expected: ["clerk open", "clerk link", "clerk init"],
      says: "Then run `clerk init` again.",
    },
  ])(
    "$name, stored session only: usage_error, exit 2, ending with `clerk init`",
    async ({ setUp, listFails, expected, says }) => {
      await setUp();
      await useCredential("session");
      listFailure = listFails;

      const result = await clerk.raw("--mode", "agent", "init", "--no-skills", "-y");
      const error = agentError(result);

      expect(result.exitCode).toBe(2);
      expect(error.code).toBe("usage_error");
      expect(error.message.startsWith(`${LEAD} `)).toBe(true);
      expect(commands(error)).toEqual([...expected]);
      expect(error.message).toContain(says);
      expect(created()).toBe(false);
    },
  );
});
