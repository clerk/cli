import { afterEach, expect, spyOn, test } from "bun:test";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as prompts from "../../../lib/prompts.ts";
import * as lists from "../../../lib/listage.ts";
import * as spinner from "../../../lib/spinner.ts";
import { useCaptureLog } from "../../../test/lib/stubs.ts";
import { capabilityFixture } from "./capability-test-helpers.ts";
import { useStarterSources } from "./setup-test-helpers.ts";
import { createIOSFixture, treeDigest } from "./test-helpers.ts";
import { runAppleInit } from "./coordinator.ts";
import { runIOSDoctorChecks } from "../../doctor/ios.ts";
import type { DoctorContext } from "../../doctor/types.ts";

const captured = useCaptureLog();
const roots: string[] = [];
const spies: ReturnType<typeof spyOn>[] = [];
afterEach(async () => {
  spies.splice(0).forEach((spy) => spy.mockRestore());
  process.exitCode = 0;
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function fixture(starter = false) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "clerk-public-init-")));
  roots.push(root);
  const f = await capabilityFixture(root);
  if (starter) await useStarterSources(root);
  f.state.apps.push({
    object: "ios_application",
    id: "ios_existing",
    bundle_id: "com.example.MyApp",
    app_id_prefix: "TEST123456",
  });
  return f;
}
function promptsFor(approve: boolean) {
  const confirm = spyOn(prompts, "confirm").mockResolvedValue(approve);
  const text = spyOn(prompts, "text").mockRejectedValue(new Error("No identity question expected"));
  const select = spyOn(lists, "select").mockResolvedValue("ui");
  spies.push(confirm, text, select);
  return { confirm, text, select };
}

test("plain interactive starter setup discovers identity, downloads packages, configures capabilities and requested UI", async () => {
  const f = await fixture(true);
  const p = promptsFor(true);
  const outro = spyOn(spinner, "outro").mockResolvedValue(undefined);
  spies.push(outro);
  const run = spyOn(f.dependencies, "run");
  spies.push(run);
  await runAppleInit({ root: f.root, agent: false }, "app_test", f.dependencies);
  expect(p.text).not.toHaveBeenCalled();
  expect(p.select).not.toHaveBeenCalled();
  expect(p.confirm.mock.calls.map((call) => call[0].message)).toEqual([
    "Add Clerk’s prebuilt sign-in screen?",
    "Enable native Sign in with Apple?",
    "Apply this setup?",
  ]);
  expect(run.mock.calls.some((call) => call[0].includes("-resolvePackageDependencies"))).toBe(true);
  // Debug and Release are read once for planning (the coordinator's inspection is
  // reused), then once more to confirm the Bundle ID from Xcode before registering.
  expect(run.mock.calls.filter((call) => call[0].includes("-showBuildSettings"))).toHaveLength(4);
  expect(await readFile(join(f.root, "MyApp/MyAppApp.swift"), "utf8")).toContain("Clerk.configure");
  expect(await readFile(join(f.root, "MyApp/ContentView.swift"), "utf8")).toContain("AuthView()");
  expect(await readFile(join(f.root, "MyApp/MyApp.entitlements"), "utf8")).toContain(
    "webcredentials:fixture.clerk.accounts.dev",
  );
  expect(f.state.events).toEqual(["enable-native", "apple-dry-run", "apple-apply"]);
  expect(captured.err).not.toContain("pk_test_");
  expect(captured.err).not.toContain("SYNTHETIC_PRESERVED_SECRET");
  expect(captured.err.split("Next steps:")[1]?.match(/•/g)).toHaveLength(2);
  expect(captured.err).not.toContain("Associated Domains requires manual setup");
  expect(outro).toHaveBeenCalledWith("CLI setup complete; app verification remains");
  expect(captured.err).not.toContain("Swift integration remains");
});

test.each([
  [true, "ABCDE12345"],
  [false, "LEGACY1234"],
])(
  "a new registration offers the signing team as the App ID Prefix (accepted: %p)",
  async (accept, prefix) => {
    const f = await fixture(true);
    f.state.apps.length = 0;
    const run = f.dependencies.run;
    f.dependencies.run = async (command, root, signal) => {
      const output = await run(command, root, signal);
      if (!command.includes("-showBuildSettings")) return output;
      const rows = JSON.parse(output);
      rows[0].buildSettings.DEVELOPMENT_TEAM = "ABCDE12345";
      return JSON.stringify(rows);
    };
    const p = promptsFor(true);
    p.select.mockResolvedValue(accept);
    p.text.mockResolvedValue("LEGACY1234");
    spies.push(spyOn(spinner, "outro").mockResolvedValue(undefined));
    await runAppleInit({ root: f.root, agent: false }, "app_test", f.dependencies);
    expect(p.select.mock.calls[0]![0].choices).toEqual([
      { name: "ABCDE12345 (signing team)", value: true },
      { name: "Enter a different App ID Prefix", value: false },
    ]);
    expect(p.text).toHaveBeenCalledTimes(accept ? 0 : 1);
    expect(f.state.apps.map((app) => app.app_id_prefix)).toEqual([prefix]);
  },
);

test("existing app receives capabilities and a precise JSON handoff without rewriting Swift; reruns are idempotent", async () => {
  const f = await fixture();
  const before = await readFile(join(f.root, "MyApp/MyAppApp.swift"), "utf8");
  const options = { root: f.root, agent: true, json: true };
  await runAppleInit(options, "app_test", f.dependencies);
  const result = JSON.parse(captured.out);
  expect(result).toMatchObject({
    status: "requires-source-integration",
    appIntegrationComplete: false,
    remote: "verified",
    packages: "resolved",
    capabilities: { status: "configured" },
  });
  expect(
    result.handoff.tasks.find((task: { id: string }) => task.id === "initialize-clerk").status,
  ).toBe("pending");
  expect(result.handoff.publishableKey).toStartWith("pk_test_");
  expect(result.handoff.xcode).toEqual({
    developerDir: "/Applications/Fixture Xcode.app/Contents/Developer",
    projectFormat: "pbxproj",
  });
  expect(
    result.handoff.tasks.find((task: { id: string }) => task.id === "runtime-verification"),
  ).toMatchObject({
    status: "unverified",
    requiresUserIntent: true,
  });
  expect(captured.out).not.toContain("SYNTHETIC_PRESERVED_SECRET");
  expect(await readFile(join(f.root, "MyApp/MyAppApp.swift"), "utf8")).toBe(before);
  captured.clear();
  await runAppleInit(options, "app_test", f.dependencies);
  expect(JSON.parse(captured.out).changedFiles).toEqual([]);
  expect(f.state.events).toEqual(["enable-native"]);
});

test("an enabled Apple provider automatically gets its local entitlement without provider writes", async () => {
  const f = await fixture();
  const outro = spyOn(spinner, "outro").mockResolvedValue(undefined);
  spies.push(outro);
  Object.assign(f.state.apple, { enabled: true, bundle_id: "com.example.MyApp" });
  await runAppleInit({ root: f.root, agent: false, yes: true }, "app_test", f.dependencies);
  expect(await readFile(join(f.root, "MyApp/MyApp.entitlements"), "utf8")).toContain(
    "com.apple.developer.applesignin",
  );
  expect(f.state.events).toEqual(["enable-native"]);
  expect(process.exitCode).toBe(0);
  expect(outro).toHaveBeenCalledWith("Project setup complete; Swift integration remains");
  expect(captured.err).toContain("Initialize Clerk and connect your sign-in flow");
  expect(captured.err).not.toContain("app verification remains");
});

test("dry run reads no remote settings, resolves no packages, and edits nothing", async () => {
  const f = await fixture();
  const before = await treeDigest(f.root);
  const read = spyOn(f.dependencies.api, "fetchApplication");
  spies.push(read);
  const run = spyOn(f.dependencies, "run");
  spies.push(run);
  await runAppleInit(
    { root: f.root, agent: true, dryRun: true, json: true },
    undefined,
    f.dependencies,
  );
  expect(JSON.parse(captured.out).mode).toBe("read-only");
  expect(read).not.toHaveBeenCalled();
  expect(run.mock.calls.some((call) => call[0].includes("-resolvePackageDependencies"))).toBe(
    false,
  );
  expect(await treeDigest(f.root)).toEqual(before);
});

test("declining the final preview leaves local files and remote settings unchanged", async () => {
  const f = await fixture(true);
  promptsFor(false);
  const before = await treeDigest(f.root);
  await expect(
    runAppleInit({ root: f.root, agent: false }, "app_test", f.dependencies),
  ).rejects.toThrow();
  expect(await treeDigest(f.root)).toEqual(before);
  expect(f.state.events).toEqual([]);
});

test("package failure returns an incomplete result but still completes native registration", async () => {
  const f = await fixture();
  const original = f.dependencies.run;
  f.dependencies.run = async (...args) => {
    if (args[0].includes("-resolvePackageDependencies")) throw new Error("network unavailable");
    return original(...args);
  };
  await expect(
    runAppleInit({ root: f.root, agent: true, json: true }, "app_test", f.dependencies),
  ).rejects.toThrow("Swift package resolution failed");
  expect(JSON.parse(captured.out)).toMatchObject({
    status: "incomplete",
    packages: "incomplete",
    remote: "verified",
  });
  expect(f.state.events).toEqual(["enable-native"]);
});

test("public doctor reads Native API before a prefix is known and never writes or resolves packages", async () => {
  const platform = process.platform;
  Object.defineProperty(process, "platform", { value: "darwin" });
  spies.push({
    mockRestore: () => Object.defineProperty(process, "platform", { value: platform }),
  } as never);
  const f = await fixture();
  f.state.apps = [];
  const before = await treeDigest(f.root);
  const run = spyOn(f.dependencies, "run");
  spies.push(run);
  const ctx = { getProfile: async () => ({ profile: { appId: "app_test" } }) } as DoctorContext;
  const results = await runIOSDoctorChecks(ctx, { root: f.root }, f.dependencies);
  expect(results.find((item) => item.name === "Native API")).toMatchObject({
    status: "warn",
    message: "Native API is disabled.",
  });
  expect(results.find((item) => item.name === "Native identity")?.message).toContain(
    "App ID Prefix",
  );
  expect(results.every((item) => !item.fix)).toBe(true);
  expect(f.state.events).toEqual([]);
  expect(run.mock.calls.some((call) => call[0].includes("-resolvePackageDependencies"))).toBe(
    false,
  );
  expect(await treeDigest(f.root)).toEqual(before);
  f.dependencies.api.fetchApplication = async () => {
    throw new Error("unavailable");
  };
  const offline = await runIOSDoctorChecks(ctx, { root: f.root }, f.dependencies);
  expect(offline.some((item) => item.name === "SDK project linkage")).toBe(true);
  expect(offline.find((item) => item.name === "Clerk native settings")?.status).toBe("warn");
});

test("installed core products and a compatible resolved SDK are preserved without unnecessary questions", async () => {
  const f = await fixture();
  await createIOSFixture(f.root, { clerkSDK: "core-only", includeKey: false });
  const directory = join(f.root, "MyApp.xcodeproj/project.xcworkspace/xcshareddata/swiftpm");
  await mkdir(directory, { recursive: true });
  const pin = (version: string) =>
    JSON.stringify({
      version: 2,
      pins: [
        {
          identity: "clerk-ios",
          location: "https://github.com/clerk/clerk-ios",
          state: { version },
        },
      ],
    });
  await writeFile(join(directory, "Package.resolved"), pin("1.5.8"));
  const p = promptsFor(true);
  await runAppleInit(
    { root: f.root, agent: false, signInWithApple: false },
    "app_test",
    f.dependencies,
  );
  expect(p.select).not.toHaveBeenCalled();
  expect(process.exitCode).toBe(0);
  expect(captured.err).not.toContain("permits versions below");
  expect(await readFile(f.path, "utf8")).not.toContain("ClerkKitUI");
  captured.clear();
  await writeFile(join(directory, "Package.resolved"), pin("1.0.0"));
  await runAppleInit({ root: f.root, agent: true, json: true }, "app_test", f.dependencies);
  expect(JSON.parse(captured.out)).toMatchObject({ status: "manual-steps-required" });
  expect(JSON.parse(captured.out).handoff.remaining).toContainEqual({
    id: "sdk-version",
    detail: expect.stringContaining("below the 1.5.8 baseline"),
  });
  expect(process.exitCode).toBe(0);
});
