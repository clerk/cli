/**
 * `clerk link` in an SDK-only folder: the only Clerk keys are the ones a Clerk
 * SDK wrote to `.clerk/.tmp/keyless.json` for an app it created for itself.
 * The CLI can't claim that app, so `link` looks for it in the account; when
 * it isn't there, a person is sent to its claim page, and an agent is told to
 * have a person run `clerk open` in their own terminal. Never the picker,
 * which only offers other apps.
 *
 * Credential: the harness default, a stored session and an API key.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import type { Application } from "../../lib/plapi.ts";
import {
  clerk,
  http,
  openedUrls,
  publishableKeyFor,
  readConfig,
  useIntegrationTestHarness,
} from "./lib/harness.ts";
import { useCleanClerkKeyEnv, useSyntheticShellClerkKeys } from "../lib/clerk-key-env.ts";

const h = useIntegrationTestHarness();

const PROFILE_KEY = "github.com/test/project";
const LIST_PATH = "/v1/platform/applications";
const TELEMETRY_URL = "https://test-telemetry.clerk.com/v1/event";
const CLAIM_TOKEN = "sdk_claim_token_secret";
const CLAIM_URL = `https://dashboard.clerk.com/apps/claim?token=${CLAIM_TOKEN}`;

/** The app the SDK created for itself; in the account only once claimed. */
const SDK_APP: Application = {
  application_id: "app_sdk",
  name: "SDK App",
  instances: [
    {
      instance_id: "ins_dev_sdk",
      environment_type: "development",
      publishable_key: publishableKeyFor("sdk-app.clerk.accounts.dev"),
      secret_key: "sk_test_sdk_app",
    },
  ],
};

/** An app already in the account: the only app a picker could offer. */
const OTHER_APP: Application = {
  application_id: "app_other",
  name: "Other App",
  instances: [
    {
      instance_id: "ins_dev_other",
      environment_type: "development",
      publishable_key: publishableKeyFor("other-app.clerk.accounts.dev"),
      secret_key: "sk_test_other_app",
    },
  ],
};

useSyntheticShellClerkKeys();
useCleanClerkKeyEnv();

/** The apps in the mocked account; a test adds the SDK's app to stand in for a claim. */
let accountApps: Application[];

beforeEach(() => {
  accountApps = [OTHER_APP];
  http.stub(async (url) => {
    if (url.startsWith(TELEMETRY_URL)) return Response.json({});
    const { pathname } = new URL(url);
    if (pathname === LIST_PATH) return Response.json(accountApps);
    for (const app of [SDK_APP, OTHER_APP]) {
      if (pathname === `${LIST_PATH}/${app.application_id}`) return Response.json(app);
    }
    return Response.json({ errors: [{ message: `unexpected ${url}` }] }, { status: 404 });
  });
});

async function writeSdkFile(overrides: Record<string, unknown> = {}) {
  await Bun.write(
    join(h.tempDir, ".clerk", ".tmp", "keyless.json"),
    JSON.stringify({
      publishableKey: SDK_APP.instances[0]!.publishable_key,
      secretKey: SDK_APP.instances[0]!.secret_key,
      claimUrl: CLAIM_URL,
      ...overrides,
    }),
  );
}

async function linkedAppId(): Promise<string | undefined> {
  return (await readConfig()).profiles[PROFILE_KEY]?.appId;
}

test("agent: links the account's app whose key the SDK's file holds", async () => {
  await writeSdkFile();
  accountApps = [OTHER_APP, SDK_APP];

  await clerk("--mode", "agent", "link");

  expect(await linkedAppId()).toBe(SDK_APP.application_id);
});

test("person, app not in the account: opens its claim page without printing the URL, exits 1, and the rerun after claiming links it", async () => {
  await writeSdkFile();

  const first = await clerk.raw("link");

  expect(first.exitCode).toBe(1);
  expect(openedUrls).toEqual([CLAIM_URL]);
  const output = first.stdout + first.stderr;
  expect(output).not.toContain(CLAIM_TOKEN);
  expect(output).not.toContain("error:");
  expect(await linkedAppId()).toBeUndefined();

  // The person claims the app in the Dashboard: it's now in the account.
  accountApps = [OTHER_APP, SDK_APP];
  const rerun = await clerk("link");

  expect(rerun.exitCode).toBe(0);
  expect(await linkedAppId()).toBe(SDK_APP.application_id);
});

test("agent, app not in the account: usage_error naming `clerk open`, and no browser", async () => {
  await writeSdkFile();

  const result = await clerk.raw("--mode", "agent", "link");

  expect(result.exitCode).toBe(2);
  expect(result.stderr).toContain('"code":"usage_error"');
  expect(result.stderr).toContain(
    `they run \`clerk open\` in their own terminal, in this project's folder, \`${h.tempDir}\``,
  );
  expect(openedUrls).toEqual([]);
  expect(await linkedAppId()).toBeUndefined();
});

test("agent, a claim URL that isn't https: usage_error saying there's no usable claim link", async () => {
  await writeSdkFile({ claimUrl: "http://dashboard.clerk.com/apps/claim?token=x" });

  const result = await clerk.raw("--mode", "agent", "link");

  expect(result.exitCode).toBe(2);
  expect(result.stderr).toContain("has no usable claim link");
  expect(openedUrls).toEqual([]);
});

describe("what telemetry records when the claim page opens", () => {
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

  test("an unfinished link, not a failure: outcome incomplete, error code not_linked, exit 1", async () => {
    await writeSdkFile();

    await clerk.raw("link");

    const events = http.requests
      .filter((r) => r.url.startsWith(TELEMETRY_URL))
      .flatMap((r) => (JSON.parse(r.body ?? "{}") as { events: Record<string, any>[] }).events);
    expect(events).toHaveLength(1);
    expect(events[0]!.payload).toMatchObject({
      outcome: "incomplete",
      error_code: "not_linked",
      exit_code: 1,
    });
  });
});
