import { afterEach, expect, spyOn, test } from "bun:test";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as prompts from "../../../lib/prompts.ts";
import * as lists from "../../../lib/listage.ts";
import * as spinner from "../../../lib/spinner.ts";
import type { Application } from "../../../lib/plapi.ts";
import { useCaptureLog } from "../../../test/lib/stubs.ts";
import { capabilityFixture } from "./capability-test-helpers.ts";
import { useStarterSources } from "./setup-test-helpers.ts";
import { treeDigest } from "./test-helpers.ts";
import { runAppleInit } from "./coordinator.ts";
import { PublishableKeyMismatch } from "./configured-key.ts";

const LINKED_DEV = `pk_test_${btoa("fixture.clerk.accounts.dev$")}`;
const literal = (key: string) => JSON.stringify(key);
const LINKED_LIVE = `pk_live_${btoa("clerk.example.com$")}`;
const OTHER_DEV = `pk_test_${btoa("other-app-42.clerk.accounts.dev$")}`;

const captured = useCaptureLog();
const roots: string[] = [];
const spies: ReturnType<typeof spyOn>[] = [];
afterEach(async () => {
  spies.splice(0).forEach((spy) => spy.mockRestore());
  process.exitCode = 0;
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

/** An existing app whose Clerk.configure is passed `argument`, a Swift expression. */
async function fixture(argument?: string, { starter = false } = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "clerk-configured-key-")));
  roots.push(root);
  const f = await capabilityFixture(root);
  if (starter) await useStarterSources(root);
  f.state.apps.push({
    object: "ios_application",
    id: "ios_existing",
    bundle_id: "com.example.MyApp",
    app_id_prefix: "TEST123456",
  });
  const fetchApplication = f.dependencies.api.fetchApplication;
  // The linked application also has a production instance.
  f.dependencies.api.fetchApplication = async (id, options) => {
    const application = await fetchApplication(id, options);
    return {
      ...application,
      name: "Linked",
      instances: [
        ...application.instances,
        { instance_id: "ins_live", environment_type: "production", publishable_key: LINKED_LIVE },
      ],
    };
  };
  if (argument)
    await writeFile(
      join(root, "MyApp/MyAppApp.swift"),
      `import ClerkKit
import SwiftUI

@main
struct MyApp: App {
  init() { Clerk.configure(publishableKey: ${argument}) }
  var body: some Scene { WindowGroup { Text("Hello") } }
}
`,
    );
  return f;
}

const otherApplication: Application = {
  application_id: "app_other",
  name: "Other",
  instances: [
    { instance_id: "ins_other", environment_type: "development", publishable_key: OTHER_DEV },
  ],
};

function noPrompts() {
  const fail = () => Promise.reject(new Error("No prompt expected"));
  for (const spy of [
    spyOn(prompts, "confirm").mockImplementation(fail),
    spyOn(prompts, "text").mockImplementation(fail),
    spyOn(lists, "select").mockImplementation(fail),
  ])
    spies.push(spy);
}

const link = { appName: "Linked", scope: "/repo" };
const relinkCommand = (appId: string) => `clerk init --app ${appId} --json --relink`;

test("an agent stops before any change when the app's key belongs to another application, and is told which", async () => {
  const f = await fixture(literal(OTHER_DEV));
  const before = await treeDigest(f.root);
  const listApplications = async () => [otherApplication];
  const error = await runAppleInit(
    { root: f.root, agent: true, json: true, link, relinkCommand },
    "app_test",
    { ...f.dependencies, listApplications },
  ).catch((caught: unknown) => caught);
  expect(error).toBeInstanceOf(PublishableKeyMismatch);
  expect((error as PublishableKeyMismatch).exitCode).toBe(2);
  const status = JSON.parse(captured.out);
  expect(status).toMatchObject({
    status: "input-required",
    appIntegrationComplete: false,
    link: {
      flag: "--relink",
      current: { appId: "app_test", appName: "Linked" },
      requested: "app_other",
      scope: "/repo",
      publishableKey: {
        configuration: "Debug",
        source: "a string literal in MyApp/MyAppApp.swift",
        frontendApiHost: "other-app-42.clerk.accounts.dev",
        application: { appId: "app_other", appName: "Other" },
      },
    },
  });
  expect(status.link.issue).toContain("Other (app_other)");
  expect(status.next[0]).toContain("clerk init --app app_other --json --relink");
  // Nothing registered, enabled, or written, and the key itself is never printed.
  expect(f.state.events).toEqual([]);
  expect(f.state.apps.map((app) => app.id)).toEqual(["ios_existing"]);
  expect(await treeDigest(f.root)).toEqual(before);
  expect(captured.out + captured.err).not.toContain(OTHER_DEV);
});

test("in human mode the stop names the key's Frontend API when its application isn't one the account can see", async () => {
  const f = await fixture(literal(OTHER_DEV));
  noPrompts();
  const error = await runAppleInit({ root: f.root, agent: false, link }, "app_test", {
    ...f.dependencies,
    listApplications: async () => [],
  }).catch((caught: unknown) => caught);
  expect(error).toBeInstanceOf(PublishableKeyMismatch);
  const message = (error as Error).message;
  expect(message).toContain("/repo is linked to Linked (app_test)");
  expect(message).toContain("other-app-42.clerk.accounts.dev");
  expect(message).toContain("clerk init --app <app_id> --relink");
  expect(captured.out).toBe("");
  expect(f.state.events).toEqual([]);
});

test("a failed application lookup still stops, without naming the key's application", async () => {
  const f = await fixture(literal(OTHER_DEV));
  const error = await runAppleInit(
    { root: f.root, agent: true, json: true, link, relinkCommand },
    "app_test",
    {
      ...f.dependencies,
      listApplications: async () => {
        throw new Error("offline");
      },
    },
  ).catch((caught: unknown) => caught);
  expect(error).toBeInstanceOf(PublishableKeyMismatch);
  const status = JSON.parse(captured.out);
  expect(status.link.requested).toBeUndefined();
  expect(status.link.publishableKey.application).toBeUndefined();
  expect(f.state.events).toEqual([]);
});

test.each([
  [LINKED_DEV, "development"],
  [LINKED_LIVE, "production"],
] as const)(
  "a key from one of the linked application's instances doesn't stop setup (%#)",
  async (key, instance) => {
    const f = await fixture(literal(key));
    const listApplications = async (): Promise<Application[]> => {
      throw new Error("No owner lookup expected");
    };
    await runAppleInit({ root: f.root, agent: true, json: true, link }, "app_test", {
      ...f.dependencies,
      listApplications,
    });
    const result = JSON.parse(captured.out);
    expect(result.status).toBe("requires-source-integration");
    expect(result.configuredKey).toEqual({
      status: "verified",
      configuration: "Debug",
      instance,
      source: "a string literal in MyApp/MyAppApp.swift",
    });
    expect(f.state.events).toEqual(["enable-native"]);
  },
);

test("a production key in the configuration being set up is called out in the human preview", async () => {
  const f = await fixture(literal(LINKED_LIVE));
  spies.push(spyOn(spinner, "outro").mockResolvedValue(undefined));
  await runAppleInit({ root: f.root, agent: false, yes: true, link }, "app_test", f.dependencies);
  expect(captured.err).toContain(
    "Debug passes Clerk.configure Linked (app_test)'s production publishable key",
  );
});

test("a key the CLI can't read doesn't block setup and is reported as unverified", async () => {
  const f = await fixture("Env.clerkPublishableKey");
  await runAppleInit({ root: f.root, agent: true, json: true, link }, "app_test", f.dependencies);
  const result = JSON.parse(captured.out);
  expect(result.status).toBe("requires-source-integration");
  expect(result.configuredKey).toMatchObject({ status: "unverified", configuration: "Debug" });
  expect(result.configuredKey.reason).toContain("gets its key from code the CLI doesn't read");
  expect(f.state.events).toEqual(["enable-native"]);

  captured.clear();
  spies.push(spyOn(spinner, "outro").mockResolvedValue(undefined));
  await runAppleInit({ root: f.root, agent: false, yes: true, link }, "app_test", f.dependencies);
  expect(captured.err).toContain("Publishable key not checked against Linked (app_test):");
});

test("an unchanged starter gets the linked application's key from setup, so it isn't checked", async () => {
  const f = await fixture(undefined, { starter: true });
  await runAppleInit({ root: f.root, agent: true, json: true, link }, "app_test", f.dependencies);
  expect(JSON.parse(captured.out).configuredKey).toBeUndefined();
});
