/**
 * Advice is tested by following it (the plan's shared rule 4). Each test
 * starts from agent-mode `clerk deploy` in a folder with no linked app, runs
 * the commands its error's `examples` name, in order, and checks where the
 * folder ends up: linked to the app its keys belong to, or still unlinked with
 * a next step that isn't the command that just ran. Rows are the state
 * table's, in `todos/grow-1249/plan.md`.
 *
 * The last example reruns `clerk deploy`; once the folder is linked, its
 * not-linked error can't recur, so it isn't run. For a folder with no keys,
 * `clerk init` is the alternative to linking an existing app ("or"), so the
 * test follows the link.
 *
 * `clerk open` prints the claim link for a person; the test stands in for the
 * person's claim in the Dashboard by adding the app to the mocked account.
 * Each test names its credential: a stored session only, the API key only, or
 * none.
 */

import { beforeEach, expect, test } from "bun:test";
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
/** The app a Clerk SDK created for itself; in the account once a person claims it. */
const SDK_APP = app("app_sdk", "sdk-app.clerk.accounts.dev");
/** The app whose keys the folder holds. */
const KEYS_APP = app("app_keys", "keys-app.clerk.accounts.dev");
/** Another app in the account. */
const OTHER_APP = app("app_other", "other-app.clerk.accounts.dev");

const pk = (target: Application) => target.instances[0]!.publishable_key;
const sk = (target: Application) => target.instances[0]!.secret_key;

useSyntheticShellClerkKeys();
useCleanClerkKeyEnv();

let accountApps: Application[];

beforeEach(async () => {
  accountApps = [OTHER_APP];
  await write("package.json", JSON.stringify({ name: "my-app" }));
  http.stub(async (url, init) => {
    const { pathname } = new URL(url);
    if (pathname === CLAIM_PATH && init?.method === "POST") {
      accountApps.push(INIT_APP);
      return Response.json(INIT_APP);
    }
    for (const known of [INIT_APP, SDK_APP, KEYS_APP, OTHER_APP]) {
      if (pathname === `${APPS_PATH}/${known.application_id}`) return Response.json(known);
    }
    if (pathname === APPS_PATH && !init?.method) return Response.json(accountApps);
    if (pathname === APPS_PATH && init?.method === "GET") return Response.json(accountApps);
    return Response.json({ errors: [{ message: `unexpected ${url}` }] }, { status: 404 });
  });
});

async function write(file: string, content: string): Promise<void> {
  await Bun.write(join(h.tempDir, file), content);
}

const envWith = (lines: string) => () => write(".env", lines);
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
  sdkApp: () =>
    write(
      ".clerk/.tmp/keyless.json",
      JSON.stringify({
        publishableKey: pk(SDK_APP),
        secretKey: sk(SDK_APP),
        claimUrl: "https://dashboard.clerk.com/apps/claim?token=sdk_claim_token",
      }),
    ),
  plainKeys: envWith(`CLERK_PUBLISHABLE_KEY=${pk(KEYS_APP)}\nCLERK_SECRET_KEY=${sk(KEYS_APP)}\n`),
  secretKeyOnly: envWith(`CLERK_SECRET_KEY=${sk(KEYS_APP)}\n`),
  none: async () => {},
};

type Credential = "session" | "api_key" | "none";

function useCredential(credential: Credential): void {
  if (credential !== "api_key") delete process.env.CLERK_PLATFORM_API_KEY;
  if (credential !== "session") mockState.storedToken = null;
}

type AgentError = { code: string; message: string; examples?: Example[] };

function agentError(result: CLIResult): AgentError {
  const line = result.stderr.split("\n").findLast((entry) => entry.startsWith('{"error"'));
  if (!line) throw new Error(`no agent error in:\n${result.stderr}`);
  return (JSON.parse(line) as { error: AgentError }).error;
}

const commands = (error: AgentError) => (error.examples ?? []).map((example) => example.command);

async function linkedAppId(): Promise<string | undefined> {
  return (await readConfig()).profiles[PROFILE_KEY]?.appId;
}

/** Runs one example command as an agent, with `<app_id>` filled in. */
async function run(command: string, appId?: string): Promise<CLIResult> {
  const args = command
    .replace("<app_id>", appId ?? "<app_id>")
    .split(" ")
    .slice(1);
  return clerk.raw("--mode", "agent", ...args);
}

type Row = {
  row: string;
  credential: Credential;
  setUp: () => Promise<void>;
  /** The apps in the account at the start. */
  account?: Application[];
  /** What the `deploy` error's examples name, in order. */
  expected: string[];
  /** How many of them the test runs. */
  follow: number;
  /** The ID an agent picks from `clerk apps list --json`. */
  appId?: string;
  /** The app a person claims in the Dashboard after `clerk open`. */
  claims?: Application;
  linkedTo: Application;
};

const ROWS: Row[] = [
  {
    row: "1, init token, signed out",
    credential: "none",
    setUp: FOLDERS.initApp,
    expected: ["clerk auth login", "clerk deploy"],
    follow: 1,
    linkedTo: INIT_APP,
  },
  {
    row: "2, init token, signed in",
    credential: "session",
    setUp: FOLDERS.initApp,
    expected: ["clerk link", "clerk deploy"],
    follow: 1,
    linkedTo: INIT_APP,
  },
  {
    row: "2, init token, signed in",
    credential: "api_key",
    setUp: FOLDERS.initApp,
    expected: ["clerk link", "clerk deploy"],
    follow: 1,
    linkedTo: INIT_APP,
  },
  {
    row: "3, SDK keyless file only, signed out",
    credential: "none",
    setUp: FOLDERS.sdkApp,
    expected: ["clerk open", "clerk auth login", "clerk link", "clerk deploy"],
    follow: 3,
    claims: SDK_APP,
    linkedTo: SDK_APP,
  },
  {
    row: "4, SDK keyless file only, signed in",
    credential: "session",
    setUp: FOLDERS.sdkApp,
    expected: ["clerk open", "clerk link", "clerk deploy"],
    follow: 2,
    claims: SDK_APP,
    linkedTo: SDK_APP,
  },
  {
    row: "5, plain keys of an app in the account, signed out",
    credential: "none",
    setUp: FOLDERS.plainKeys,
    account: [OTHER_APP, KEYS_APP],
    expected: ["clerk auth login", "clerk link", "clerk deploy"],
    follow: 2,
    linkedTo: KEYS_APP,
  },
  {
    row: "6, plain keys of an app in the account, signed in",
    credential: "session",
    setUp: FOLDERS.plainKeys,
    account: [OTHER_APP, KEYS_APP],
    expected: ["clerk link", "clerk deploy"],
    follow: 1,
    linkedTo: KEYS_APP,
  },
  {
    row: "8, a secret key only, signed in",
    credential: "session",
    setUp: FOLDERS.secretKeyOnly,
    account: [OTHER_APP, KEYS_APP],
    expected: ["clerk apps list --json", "clerk link --app <app_id>", "clerk deploy"],
    follow: 2,
    appId: KEYS_APP.application_id,
    linkedTo: KEYS_APP,
  },
  {
    row: "9, no keys, signed out",
    credential: "none",
    setUp: FOLDERS.none,
    expected: [
      "clerk auth login",
      "clerk apps list --json",
      "clerk link --app <app_id>",
      "clerk init",
      "clerk deploy",
    ],
    follow: 3,
    appId: OTHER_APP.application_id,
    linkedTo: OTHER_APP,
  },
  {
    row: "10, no keys, signed in",
    credential: "session",
    setUp: FOLDERS.none,
    expected: ["clerk apps list --json", "clerk link --app <app_id>", "clerk init", "clerk deploy"],
    follow: 2,
    appId: OTHER_APP.application_id,
    linkedTo: OTHER_APP,
  },
];

test.each(ROWS)(
  "row $row, $credential: following deploy's advice links $linkedTo.application_id",
  async ({ credential, setUp, account, expected, follow, appId, claims, linkedTo }) => {
    await setUp();
    useCredential(credential);
    if (account) accountApps = [...account];

    const stopped = await run("clerk deploy");
    const error = agentError(stopped);
    expect(stopped.exitCode).toBe(1);
    expect(error.code).toBe("not_linked");
    expect(commands(error)).toEqual(expected);

    for (const command of expected.slice(0, follow)) {
      const result = await run(command, appId);
      expect({ command, exitCode: result.exitCode }).toEqual({ command, exitCode: 0 });
      if (command === "clerk apps list --json") expect(result.stdout).toContain(appId!);
      if (command === "clerk open" && claims) accountApps.push(claims);
    }

    expect(await linkedAppId()).toBe(linkedTo.application_id);
    if (credential === "api_key") expect(openedUrls).toEqual([]);
  },
);

// Row 7: the folder's key belongs to an app in another account. `clerk link`
// can't find it, and its own stop names a different next step.
test("row 7, plain keys of an app not in the account, signed in: `clerk link` stops with a different next step", async () => {
  await FOLDERS.plainKeys();
  useCredential("session");

  const stopped = await run("clerk deploy");
  expect(commands(agentError(stopped))).toEqual(["clerk link", "clerk deploy"]);

  const linked = await run("clerk link");
  const error = agentError(linked);

  expect(linked.exitCode).toBe(2);
  expect(error.code).toBe("usage_error");
  expect(commands(error)[0]).not.toBe("clerk link");
  expect(await linkedAppId()).toBeUndefined();
});
