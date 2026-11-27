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
const OTHER_LIVE = `pk_live_${btoa("clerk.other.example$")}`;

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

/** Debug and Release read the key from Info.plist, set by a build setting that differs per configuration. */
function keyPerConfiguration(f: Awaited<ReturnType<typeof fixture>>, keys: Record<string, string>) {
  const run = f.dependencies.run;
  f.dependencies.run = async (command, root, signal) => {
    const output = await run(command, root, signal);
    if (!command.includes("-showBuildSettings")) return output;
    const configuration = command[command.indexOf("-configuration") + 1]!;
    const rows = JSON.parse(output);
    Object.assign(rows[0].buildSettings, {
      INFOPLIST_FILE: "MyApp/Info.plist",
      CLERK_PUBLISHABLE_KEY: keys[configuration],
    });
    return JSON.stringify(rows);
  };
  return writeFile(
    join(f.root, "MyApp/Info.plist"),
    `<?xml version="1.0" encoding="UTF-8"?>\n<plist version="1.0"><dict><key>ClerkPublishableKey</key><string>$(CLERK_PUBLISHABLE_KEY)</string></dict></plist>\n`,
  );
}

const PLIST_ARGUMENT = 'Bundle.main.object(forInfoDictionaryKey: "ClerkPublishableKey") as! String';

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

const link = {
  appName: "Linked",
  scope: "/repo",
  relinkEffect: "this switches the link for every project in /repo",
};
const retryCommand = (appId?: string) => `clerk init --app ${appId ?? "<app_id>"} --json --relink`;

test("an agent stops before any change when the app's key belongs to another application, and is told which", async () => {
  const f = await fixture(literal(OTHER_DEV));
  const before = await treeDigest(f.root);
  f.dependencies.api.listApplications = async () => [otherApplication];
  const error = await runAppleInit(
    { root: f.root, agent: true, json: true, link, retryCommand },
    "app_test",
    f.dependencies,
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
      // One literal serves both configurations.
      publishableKeys: ["Debug", "Release"].map((configuration) => ({
        configuration,
        source: "a string literal in MyApp/MyAppApp.swift",
        frontendApiHost: "other-app-42.clerk.accounts.dev",
        application: { appId: "app_other", appName: "Other" },
      })),
    },
  });
  expect(status.link.issue).toContain("Other (app_other)");
  // One literal read by both configurations is described once.
  expect(status.link.issue).toContain(
    "in Debug and Release (from a string literal in MyApp/MyAppApp.swift) belongs to Other (app_other).",
  );
  expect(status.next[1]).toContain(
    "change the key for Debug and Release to Linked (app_test)'s development publishable key",
  );
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
  const error = await runAppleInit(
    { root: f.root, agent: false, link },
    "app_test",
    f.dependencies,
  ).catch((caught: unknown) => caught);
  expect(error).toBeInstanceOf(PublishableKeyMismatch);
  const message = (error as Error).message;
  expect(message).toContain("/repo is linked to Linked (app_test)");
  expect(message).toContain("other-app-42.clerk.accounts.dev");
  expect(message).toContain("clerk init --app <app_id> --relink");
  expect(message).toContain("this switches the link for every project in /repo");
  expect(message).toContain("so no setup was applied");
  expect(captured.out).toBe("");
  expect(f.state.events).toEqual([]);
});

test("a failed application lookup still stops, without naming the key's application", async () => {
  const f = await fixture(literal(OTHER_DEV));
  f.dependencies.api.listApplications = async () => {
    throw new Error("offline");
  };
  const error = await runAppleInit(
    { root: f.root, agent: true, json: true, link, retryCommand },
    "app_test",
    f.dependencies,
  ).catch((caught: unknown) => caught);
  expect(error).toBeInstanceOf(PublishableKeyMismatch);
  const status = JSON.parse(captured.out);
  expect(status.link.requested).toBeUndefined();
  expect(status.link.flag).toBe("--relink");
  expect(status.link.publishableKeys[0].application).toBeUndefined();
  expect(f.state.events).toEqual([]);
});

test.each([
  [LINKED_DEV, "development"],
  [LINKED_LIVE, "production"],
] as const)(
  "a key from one of the linked application's instances doesn't stop setup (%#)",
  async (key, instance) => {
    const f = await fixture(literal(key));
    f.dependencies.api.listApplications = async (): Promise<Application[]> => {
      throw new Error("No owner lookup expected");
    };
    await runAppleInit({ root: f.root, agent: true, json: true, link }, "app_test", f.dependencies);
    const result = JSON.parse(captured.out);
    expect(result.status).toBe("requires-source-integration");
    expect(result.configuredKeys).toEqual(
      ["Debug", "Release"].map((configuration) => ({
        status: "verified",
        configuration,
        instance,
        source: "a string literal in MyApp/MyAppApp.swift",
      })),
    );
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
  expect(captured.err).not.toContain("Release passes Clerk.configure");
});

test("a key the CLI can't read doesn't block setup and is reported as unverified", async () => {
  const f = await fixture("Env.clerkPublishableKey");
  await runAppleInit({ root: f.root, agent: true, json: true, link }, "app_test", f.dependencies);
  const result = JSON.parse(captured.out);
  expect(result.status).toBe("requires-source-integration");
  expect(
    result.configuredKeys.map((check: { configuration: string }) => check.configuration),
  ).toEqual(["Debug", "Release"]);
  expect(result.configuredKeys[0]).toMatchObject({ status: "unverified" });
  expect(result.configuredKeys[0].reason).toContain("gets its key from code the CLI doesn't read");
  expect(f.state.events).toEqual(["enable-native"]);

  captured.clear();
  spies.push(spyOn(spinner, "outro").mockResolvedValue(undefined));
  await runAppleInit({ root: f.root, agent: false, yes: true, link }, "app_test", f.dependencies);
  // Debug and Release share the unreadable call, so the note prints once.
  expect(captured.err.match(/Publishable key not checked/g)).toEqual([
    "Publishable key not checked",
  ]);
  expect(captured.err).toContain(
    "Publishable key not checked against Linked (app_test) (Debug, Release):",
  );
});

test("an unchanged starter has no key of its own to check, so it gets no unverified note", async () => {
  const f = await fixture(undefined, { starter: true });
  await runAppleInit({ root: f.root, agent: true, json: true, link }, "app_test", f.dependencies);
  expect(JSON.parse(captured.out).configuredKeys).toBeUndefined();
});

test("Debug on the linked application and Release on another stops without offering a relink that would only move the problem", async () => {
  const f = await fixture(PLIST_ARGUMENT);
  await keyPerConfiguration(f, { Debug: LINKED_DEV, Release: OTHER_LIVE });
  const before = await treeDigest(f.root);
  const error = await runAppleInit(
    { root: f.root, agent: true, json: true, link, retryCommand },
    "app_test",
    f.dependencies,
  ).catch((caught: unknown) => caught);
  expect(error).toBeInstanceOf(PublishableKeyMismatch);
  const status = JSON.parse(captured.out);
  expect(status.link.flag).toBeUndefined();
  expect(status.link).toMatchObject({
    publishableKeys: [
      {
        configuration: "Release",
        source:
          "the Info.plist entry ClerkPublishableKey, set by the CLERK_PUBLISHABLE_KEY build setting",
        frontendApiHost: "clerk.other.example",
      },
    ],
  });
  expect(status.link.requested).toBeUndefined();
  expect(status.link.issue).toContain("Debug uses Linked (app_test)'s key");
  expect(status.link.issue).not.toContain("--relink");
  // Keeping the link keeps Release on production.
  expect(status.next[1]).toContain(
    "the key for Release to Linked (app_test)'s production publishable key",
  );
  // Setting up Debug alone could still edit entitlements Release signs with, so it isn't offered.
  expect(status.next).toHaveLength(2);
  expect(status.link.issue).not.toContain("--xcode-configuration");
  expect(f.state.events).toEqual([]);
  expect(await treeDigest(f.root)).toEqual(before);
});

test("Debug and Release on two different known applications offer no relink", async () => {
  const f = await fixture(PLIST_ARGUMENT);
  await keyPerConfiguration(f, { Debug: OTHER_DEV, Release: OTHER_LIVE });
  f.dependencies.api.listApplications = async () => [
    otherApplication,
    {
      application_id: "app_third",
      instances: [
        { instance_id: "ins_third", environment_type: "production", publishable_key: OTHER_LIVE },
      ],
    },
  ];
  await runAppleInit(
    { root: f.root, agent: true, json: true, link, retryCommand },
    "app_test",
    f.dependencies,
  ).catch(() => undefined);
  const status = JSON.parse(captured.out);
  expect(status.link.flag).toBeUndefined();
  expect(
    status.link.publishableKeys.map((key: { configuration: string }) => key.configuration),
  ).toEqual(["Debug", "Release"]);
  expect(status.next.join(" ")).not.toContain("--relink");
});

test("different keys whose application the CLI can't list offer no relink", async () => {
  const f = await fixture(PLIST_ARGUMENT);
  await keyPerConfiguration(f, { Debug: OTHER_DEV, Release: OTHER_LIVE });
  f.dependencies.api.listApplications = async () => {
    throw new Error("offline");
  };
  await runAppleInit(
    { root: f.root, agent: true, json: true, link, retryCommand },
    "app_test",
    f.dependencies,
  ).catch(() => undefined);
  const status = JSON.parse(captured.out);
  expect(status.link.flag).toBeUndefined();
  expect(status.next.join(" ")).not.toContain("--relink");
});

test("a listed application's key and an unlisted one offer no relink", async () => {
  const f = await fixture(PLIST_ARGUMENT);
  await keyPerConfiguration(f, { Debug: OTHER_DEV, Release: OTHER_LIVE });
  f.dependencies.api.listApplications = async () => [otherApplication];
  await runAppleInit(
    { root: f.root, agent: true, json: true, link, retryCommand },
    "app_test",
    f.dependencies,
  ).catch(() => undefined);
  const status = JSON.parse(captured.out);
  expect(status.link.flag).toBeUndefined();
  expect(status.link.requested).toBeUndefined();
});

test("Debug and Release on the same other application offer the relink", async () => {
  const f = await fixture(PLIST_ARGUMENT);
  await keyPerConfiguration(f, { Debug: OTHER_DEV, Release: OTHER_LIVE });
  f.dependencies.api.listApplications = async () => [
    {
      ...otherApplication,
      instances: [
        ...otherApplication.instances,
        {
          instance_id: "ins_other_live",
          environment_type: "production",
          publishable_key: OTHER_LIVE,
        },
      ],
    },
  ];
  await runAppleInit(
    { root: f.root, agent: true, json: true, link, retryCommand },
    "app_test",
    f.dependencies,
  ).catch(() => undefined);
  const status = JSON.parse(captured.out);
  expect(status.link).toMatchObject({ flag: "--relink", requested: "app_other" });
  expect(status.next[1]).toContain(
    "the key for Debug to Linked (app_test)'s development publishable key, and the key for Release to Linked (app_test)'s production publishable key",
  );
});

test("a failed read of the linked application stops setup instead of skipping the check", async () => {
  const f = await fixture(literal(OTHER_DEV));
  f.dependencies.api.fetchApplication = async () => {
    throw new Error("Service unavailable");
  };
  await expect(
    runAppleInit({ root: f.root, agent: true, json: true, link }, "app_test", f.dependencies),
  ).rejects.toThrow("Service unavailable");
  expect(f.state.events).toEqual([]);
});

test("rerunning a set-up starter to add the sign-in view keeps the key results", async () => {
  const f = await fixture(undefined, { starter: true });
  await runAppleInit({ root: f.root, agent: true, json: true, link }, "app_test", f.dependencies);
  captured.clear();
  await runAppleInit(
    { root: f.root, agent: true, json: true, link, prebuiltAuthUi: true },
    "app_test",
    f.dependencies,
  );
  const result = JSON.parse(captured.out);
  expect(result.changedFiles).toEqual(["MyApp/ContentView.swift"]);
  expect(result.configuredKeys?.[0]).toMatchObject({ status: "verified", instance: "development" });
});

test("a relink isn't offered while another configuration's key couldn't be checked", async () => {
  const f = await fixture(PLIST_ARGUMENT);
  await keyPerConfiguration(f, { Debug: OTHER_DEV, Release: "not-a-publishable-key" });
  f.dependencies.api.listApplications = async () => [otherApplication];
  await runAppleInit(
    { root: f.root, agent: true, json: true, link, retryCommand },
    "app_test",
    f.dependencies,
  ).catch(() => undefined);
  const status = JSON.parse(captured.out);
  expect(status.link.flag).toBeUndefined();
  expect(status.link.requested).toBeUndefined();
  expect(status.link.issue).toContain("Release's key couldn't be checked");
  expect(status.link.question).toContain("Release's key couldn't be checked");
  expect(status.link.question).not.toContain("different applications");
});
