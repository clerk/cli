import { afterEach, expect, spyOn, test } from "bun:test";
import { build, parse } from "@bacons/xcode/json";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { useCaptureLog } from "../../../test/lib/stubs.ts";
import { capabilityFixture } from "./capability-test-helpers.ts";
import { IOS_FIXTURE_IDS as ids } from "./test-helpers.ts";
import { planAllCapabilities } from "./capabilities.ts";
import * as coordinator from "./coordinator.ts";
import { runAppleInit } from "./coordinator.ts";
import { doctor } from "./doctor.ts";
import { describePreview, prepareSetup } from "./workflow.ts";
import { inspectSelectedProject, type CommandRunner } from "./xcode.ts";
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

const DOMAIN = "webcredentials:fixture.clerk.accounts.dev";

/** Xcode's Multiplatform App template, signed by a team Xcode marks personal or paid. */
async function fixture(
  options: { personal?: boolean; entitlements?: boolean; appleInClerk?: boolean } = {},
) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "clerk-multiplatform-")));
  roots.push(root);
  const f = await capabilityFixture(root, "multiplatform");
  if (options.entitlements === false) await editTargetSettings(f.path, {});
  if (options.appleInClerk)
    f.state.apple = { ...f.state.apple, enabled: true, bundle_id: "com.example.MyApp" };
  const run = f.dependencies.run;
  const dependencies = {
    ...f.dependencies,
    xcodeTeams: [{ id: "TEAMID1234", name: "Sean Perez", personal: options.personal === true }],
    run: (async (command, cwd, signal) => {
      const rows = JSON.parse(await run(command, cwd, signal));
      for (const row of rows) row.buildSettings.DEVELOPMENT_TEAM = "TEAMID1234";
      return JSON.stringify(rows);
    }) satisfies CommandRunner,
  };
  return { ...f, dependencies };
}

/** Replaces the target's entitlement routes in both configurations, leaving other settings alone. */
async function editTargetSettings(path: string, settings: Record<string, string>) {
  const graph = parse(await readFile(path, "utf8"));
  for (const id of [ids.targetDebug, ids.targetRelease]) {
    const buildSettings = (graph.objects![id] as any).buildSettings;
    delete buildSettings.CODE_SIGN_ENTITLEMENTS;
    Object.assign(buildSettings, settings);
  }
  await writeFile(path, build(graph));
}

function targetSettings(source: string, id: string): Record<string, string> {
  return (parse(source).objects as Record<string, any>)[id].buildSettings;
}

async function init(f: Awaited<ReturnType<typeof fixture>>) {
  captured.clear();
  await runAppleInit(
    { root: f.root, agent: true, json: true, appIdPrefix: "TEAMID1234" },
    "app_test",
    f.dependencies,
  );
  return JSON.parse(captured.out);
}

async function doctorChecks(f: Awaited<ReturnType<typeof fixture>>) {
  spies.push(spyOn(coordinator, "canSetUpXcode").mockReturnValue(true));
  const ctx = {
    getProfile: async () => ({ profile: { appId: "app_test" } }),
  } as unknown as DoctorContext;
  return runIOSDoctorChecks(ctx, { root: f.root }, f.dependencies);
}

test("inspects each configuration for iOS and macOS, and names the platforms it leaves alone", async () => {
  const f = await fixture();
  const commands: string[][] = [];
  const inspection = await inspectSelectedProject(
    { root: f.root, products: "ui", minimumVersion: "1.0.0" },
    async (command, cwd, signal) => {
      commands.push(command);
      return f.dependencies.run(command, cwd, signal);
    },
  );
  expect(
    inspection.contexts.map(({ selection }) => `${selection.configuration}/${selection.sdk}`),
  ).toEqual(["Debug/iphoneos", "Debug/macosx", "Release/iphoneos", "Release/macosx"]);
  expect(inspection.unsupportedPlatforms).toEqual(["visionOS"]);
  expect(inspection.platformNeutralSettingsJSON).toHaveLength(2);
  expect(
    commands.map((command) =>
      command.includes("-sdk") ? command[command.indexOf("-sdk") + 1] : "auto",
    ),
  ).toEqual(["auto", "iphoneos", "macosx", "auto", "iphoneos", "macosx"]);
});

test("a target listing only platforms Clerk doesn't set up still needs manual setup", async () => {
  const f = await fixture();
  const run: CommandRunner = async (command, cwd, signal) => {
    const rows = JSON.parse(await f.dependencies.run(command, cwd, signal));
    rows[0].buildSettings.SUPPORTED_PLATFORMS = "xros xrsimulator";
    return JSON.stringify(rows);
  };
  await expect(
    inspectSelectedProject({ root: f.root, products: "ui", minimumVersion: "1.0.0" }, run),
  ).rejects.toThrow("Select an iOS or macOS build context; this platform needs manual setup.");
});

test("a paid team keeps one shared entitlements file for both platforms", async () => {
  const f = await fixture({ appleInClerk: true });
  const result = await init(f);
  expect(result.status).not.toBe("incomplete");
  const shared = await readFile(join(f.root, "MyApp/MyApp.entitlements"), "utf8");
  expect(shared).toContain(DOMAIN);
  expect(shared).toContain("com.apple.developer.applesignin");
  // The sandboxed Mac build needs outgoing network access; iOS ignores the sandbox keys.
  expect(shared).toContain("com.apple.security.network.client");
  expect(shared).toContain("com.apple.security.files.user-selected.read-only");
  const source = await readFile(f.path, "utf8");
  for (const id of [ids.targetDebug, ids.targetRelease]) {
    const settings = targetSettings(source, id);
    expect(settings.CODE_SIGN_ENTITLEMENTS).toBe("MyApp/MyApp.entitlements");
    expect(settings["CODE_SIGN_ENTITLEMENTS[sdk=macosx*]"]).toBeUndefined();
    expect(settings["ENABLE_OUTGOING_NETWORK_CONNECTIONS[sdk=macosx*]"]).toBe("YES");
  }
  expect(result.changedFiles).toEqual([
    "MyApp/MyApp.entitlements",
    "MyApp.xcodeproj/project.pbxproj",
  ]);
  // One registration covers both platforms.
  expect(f.state.apps.map((app) => app.bundle_id)).toEqual(["com.example.MyApp"]);
  expect(result.handoff.context.platforms).toEqual(["iphoneos", "macosx"]);
  expect(result.handoff.context.unsupportedPlatforms).toEqual(["visionOS"]);
  expect(result.handoff.configurations).toEqual(["Debug", "Release"]);
  expect(
    result.handoff.remaining.some((item: { id: string }) => item.id === "associated-domains"),
  ).toBe(false);
});

test("a Personal Team splits the shared file so the Mac build has no Associated Domain", async () => {
  const f = await fixture({ personal: true, appleInClerk: true });
  const original = await readFile(join(f.root, "MyApp/MyApp.entitlements"), "utf8");
  const result = await init(f);
  expect(result.status).toBe("manual-steps-required");
  const iOS = await readFile(join(f.root, "MyApp/MyApp.entitlements"), "utf8");
  expect(iOS).toContain(DOMAIN);
  expect(iOS).not.toContain("com.apple.developer.applesignin");
  const mac = await readFile(join(f.root, "MyApp/MyApp-macOS.entitlements"), "utf8");
  expect(mac).not.toContain("com.apple.developer.associated-domains");
  expect(mac).not.toContain("com.apple.developer.applesignin");
  // The copy keeps everything the shared file had.
  for (const key of [
    "com.apple.security.app-sandbox",
    "com.apple.security.files.user-selected.read-only",
  ]) {
    expect(original).toContain(key);
    expect(mac).toContain(key);
  }
  expect(mac).toContain("com.apple.security.network.client");
  const source = await readFile(f.path, "utf8");
  for (const id of [ids.targetDebug, ids.targetRelease]) {
    const settings = targetSettings(source, id);
    expect(settings.CODE_SIGN_ENTITLEMENTS).toBe("MyApp/MyApp.entitlements");
    expect(settings["CODE_SIGN_ENTITLEMENTS[sdk=macosx*]"]).toBe("MyApp/MyApp-macOS.entitlements");
  }
  // The JSON handoff says the Mac side lost passkeys and AutoFill, and that iOS keeps them.
  const domains = result.handoff.remaining.filter(
    (item: { id: string }) => item.id === "associated-domains",
  );
  expect(domains).toHaveLength(1);
  expect(domains[0].detail).toContain("left out of the macOS app");
  expect(domains[0].detail).toContain("passkeys and password AutoFill stay off on Mac");
  expect(domains[0].detail).toContain("The iOS app keeps them");

  // Rerunning changes nothing, and doctor finds both platforms set up.
  const project = await readFile(f.path, "utf8");
  const rerun = await init(f);
  expect(rerun.changedFiles).toEqual([]);
  expect(await readFile(f.path, "utf8")).toBe(project);
  const checks = await doctorChecks(f);
  expect(
    checks
      .filter((check) => check.name.startsWith("Capabilities:"))
      .map((check) => [/MyApp, (\w+, \w+);/.exec(check.name)?.[1], check.status]),
  ).toEqual([
    ["Debug, iphoneos", "pass"],
    ["Debug, macosx", "pass"],
    ["Release, iphoneos", "pass"],
    ["Release, macosx", "pass"],
  ]);
  const personal = checks.find((check) => check.name === "Personal Team");
  expect(personal?.message).toContain("those stay off in the macOS app");
  expect(personal?.message).toContain("The iOS app keeps its Associated Domains");
  expect(personal?.message).not.toContain("left out");
});

test("the setup preview tells a person at the terminal the Mac side has no passkeys", async () => {
  const f = await fixture({ personal: true });
  const preview = await prepareSetup(
    { ...f.options, signInWithApple: false, personalTeam: true },
    f.dependencies,
  );
  coordinator.printSetupPreview(preview);
  expect(captured.err).toContain("Set up MyApp for iOS and macOS (Debug, Release)");
  expect(captured.err).toContain("Create MyApp/MyApp-macOS.entitlements");
  expect(captured.err).toContain("Associated Domains were left out of the macOS app");
  expect(captured.err).toContain("visionOS build is left unchanged");
  const described = describePreview(preview);
  expect(described.context).toMatchObject({ platforms: ["iphoneos", "macosx"] });
  expect(described.coverage).toMatchObject({ unsupportedPlatforms: ["visionOS"] });
});

test("the human setup result says the Mac side has no passkeys and iOS keeps them", async () => {
  const f = await fixture({ personal: true });
  await runAppleInit(
    { root: f.root, agent: true, appIdPrefix: "TEAMID1234" },
    "app_test",
    f.dependencies,
  );
  const result = captured.err.split("Next steps:")[0]!.split("native registration verified")[1];
  expect(result).toContain("Associated Domains were left out of the macOS app");
  expect(result).toContain("The iOS app keeps them");
});

test("without an entitlements file, a paid team gets one file and a Personal Team only an iOS one", async () => {
  const paid = await fixture({ entitlements: false });
  await init(paid);
  let source = await readFile(paid.path, "utf8");
  expect(targetSettings(source, ids.targetDebug)).toMatchObject({
    "CODE_SIGN_ENTITLEMENTS[sdk=iphone*]": "MyApp.entitlements",
    "CODE_SIGN_ENTITLEMENTS[sdk=macosx*]": "MyApp.entitlements",
  });
  expect(await readFile(join(paid.root, "MyApp.entitlements"), "utf8")).toContain(DOMAIN);
  expect(await Bun.file(join(paid.root, "MyApp-macOS.entitlements")).exists()).toBe(false);

  const personal = await fixture({ personal: true, entitlements: false });
  const result = await init(personal);
  source = await readFile(personal.path, "utf8");
  const settings = targetSettings(source, ids.targetRelease);
  expect(settings["CODE_SIGN_ENTITLEMENTS[sdk=iphone*]"]).toBe("MyApp.entitlements");
  expect(settings["CODE_SIGN_ENTITLEMENTS[sdk=macosx*]"]).toBeUndefined();
  expect(settings["ENABLE_OUTGOING_NETWORK_CONNECTIONS[sdk=macosx*]"]).toBe("YES");
  expect(await readFile(join(personal.root, "MyApp.entitlements"), "utf8")).toContain(DOMAIN);
  expect(
    result.handoff.remaining.some((item: { detail: string }) =>
      item.detail.includes("left out of the macOS app"),
    ),
  ).toBe(true);
});

test("a Mac copy that would replace an existing file needs manual setup instead", async () => {
  const f = await fixture();
  await writeFile(join(f.root, "MyApp/MyApp-macOS.entitlements"), "<plist/>");
  const inspection = await inspectSelectedProject(
    { root: f.root, products: "ui", minimumVersion: "1.0.0" },
    f.dependencies.run,
  );
  const plan = await planAllCapabilities(
    inspection,
    inspection.document.source,
    "fixture.clerk.accounts.dev",
    false,
    (selection) => selection.sdk !== "macosx",
  );
  expect(plan.status).toBe("manual");
  expect(plan.reason).toContain("The proposed new entitlement file already exists");
  expect(plan.actions.some((action) => action.path.endsWith("-macOS.entitlements"))).toBe(false);
});

test("different Bundle IDs per platform stop setup before any write, and doctor names them", async () => {
  const f = await fixture();
  await editTargetSettings(f.path, {
    CODE_SIGN_ENTITLEMENTS: "MyApp/MyApp.entitlements",
    "PRODUCT_BUNDLE_IDENTIFIER[sdk=macosx*]": "com.example.MyApp.mac",
  });
  const before = await readFile(f.path, "utf8");
  await expect(
    runAppleInit(
      { root: f.root, agent: true, json: true, appIdPrefix: "TEAMID1234" },
      "app_test",
      f.dependencies,
    ),
  ).rejects.toThrow(
    "This target builds com.example.MyApp for iOS and com.example.MyApp.mac for macOS. Clerk registers one Bundle ID",
  );
  expect(await readFile(f.path, "utf8")).toBe(before);
  expect(f.state.events).toEqual([]);
  const report = await doctor(
    { ...f.options, remote: { applicationId: "app_test" } },
    f.dependencies,
  );
  expect(report.checks.find((check) => check.name === "Native identity")?.message).toContain(
    "com.example.MyApp.mac for macOS",
  );
});

test("doctor checks each configuration on both platforms", async () => {
  const f = await fixture({ appleInClerk: true });
  const checks = await doctorChecks(f);
  expect(checks.find((check) => check.name === "Xcode configuration coverage")).toMatchObject({
    status: "warn",
    message: expect.stringContaining("Inspected Debug, Release for iOS and macOS"),
  });
  expect(
    checks
      .filter((check) => check.name.startsWith("Apple entitlement:"))
      .map((check) => check.name),
  ).toEqual([
    "Apple entitlement: Debug (iOS)",
    "Apple entitlement: Debug (macOS)",
    "Apple entitlement: Release (iOS)",
    "Apple entitlement: Release (macOS)",
  ]);
  expect(
    checks.filter((check) => check.name.startsWith("Capabilities:")).map((check) => check.status),
  ).toEqual(["warn", "warn", "warn", "warn"]);
});

test("production checks name the platform of each Release build", async () => {
  const f = await fixture({ personal: true });
  await init(f);
  const live = `pk_live_${btoa("clerk.example.com$")}`;
  const fetchApplication = f.dependencies.api.fetchApplication;
  f.dependencies.api.fetchApplication = async (id, options) => {
    const application = await fetchApplication(id, options);
    return {
      ...application,
      instances: [
        ...application.instances,
        { instance_id: "ins_prod", environment_type: "production", publishable_key: live },
      ],
    };
  };
  const report = await doctor(
    { ...f.options, remote: { applicationId: "app_test" } },
    f.dependencies,
  );
  const domains = report.checks.filter((check) =>
    check.name.startsWith("Production associated domain:"),
  );
  expect(domains.map((check) => check.name)).toEqual([
    "Production associated domain: Release (iOS)",
    "Production associated domain: Release (macOS)",
  ]);
  expect(domains[1]!.message).toContain("Release (macOS) entitlements don't include");
});
