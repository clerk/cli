import type { CommandRunner } from "./xcode.ts";
import { capabilityFixture } from "./capability-test-helpers.ts";
import { afterEach, expect, test } from "bun:test";
import { build, parse } from "@bacons/xcode/json";
import { chmod, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { useCaptureLog } from "../../../test/lib/stubs.ts";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { IOS_FIXTURE_IDS as ids, treeDigest } from "./test-helpers.ts";
import { capabilityXML } from "./capabilities.ts";
import { applySetup, describePreview, prepareSetup } from "./workflow.ts";
import { doctor } from "./doctor.ts";
import { useStarterSources } from "./setup-test-helpers.ts";
import { integrationHandoff } from "./handoff.ts";

const key = `pk_test_${btoa("fixture.clerk.accounts.dev$")}`;
const roots: string[] = [];
useCaptureLog();
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
/** Adds another target to the fake `xcodebuild -alltargets` output, as Xcode resolves it. */
function reportOtherTarget(
  f: Awaited<ReturnType<typeof fixture>>,
  settings: Record<string, string>,
  configuration?: string,
): void {
  const run = f.dependencies.run;
  f.dependencies.run = async (command, root, signal) => {
    const rows = JSON.parse(await run(command, root, signal));
    if (!configuration || command[command.indexOf("-configuration") + 1] === configuration)
      rows.push({ target: "AdminApp", buildSettings: { SRCROOT: f.root, ...settings } });
    return JSON.stringify(rows);
  };
}

async function fixture(platform: "ios" | "macos" = "ios", secondTarget = false) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "clerk-apple-capability-")));
  roots.push(root);
  return capabilityFixture(root, platform, secondTarget);
}

for (const platform of ["ios", "macos"] as const)
  test(`${platform}: capability edits, Apple activation, preservation, and rerun`, async () => {
    const f = await fixture(platform);
    const before = await treeDigest(f.root);
    const projectBefore = parse(await readFile(f.path, "utf8")).objects as Record<string, any>;
    const preview = await prepareSetup(f.options, f.dependencies);
    expect(preview.capabilities?.status).toBe("planned");
    expect(preview.apple?.status).toBe("ready");
    expect(await treeDigest(f.root)).toEqual(before);
    expect(JSON.stringify(describePreview(preview))).not.toContain("SYNTHETIC_PRESERVED_SECRET");
    const result = await applySetup(preview, f.dependencies);
    expect(result).toMatchObject({ local: "updated", remote: "verified", apple: "verified" });
    expect(result.backups).toHaveLength(2);
    expect(f.state.events).toEqual(["register", "enable-native", "apple-dry-run", "apple-apply"]);
    expect(f.state.apple).toMatchObject({
      enabled: true,
      authenticatable: true,
      bundle_id: "com.example.MyApp",
      client_secret: "SYNTHETIC_PRESERVED_SECRET",
    });
    const entitlements = await readFile(join(f.root, "MyApp/MyApp.entitlements"), "utf8");
    expect(entitlements).toContain("com.apple.developer.applesignin");
    expect(entitlements).toContain("webcredentials:fixture.clerk.accounts.dev");
    const projectAfter = parse(await readFile(f.path, "utf8")).objects as Record<string, any>;
    if (platform === "ios")
      expect(projectAfter[ids.targetRelease]).toEqual(projectBefore[ids.targetRelease]);
    else
      expect(
        projectAfter[ids.targetRelease].buildSettings[
          "ENABLE_OUTGOING_NETWORK_CONNECTIONS[sdk=macosx*]"
        ],
      ).toBe("YES");
    if (platform === "macos")
      expect(
        projectAfter[ids.targetDebug].buildSettings[
          "ENABLE_OUTGOING_NETWORK_CONNECTIONS[sdk=macosx*]"
        ],
      ).toBe("YES");
    const next = await prepareSetup(f.options, f.dependencies);
    expect(next.capabilities?.status).toBe("satisfied");
    expect(next.apple?.status).toBe("satisfied");
    const after = await treeDigest(f.root);
    expect((await applySetup(next, f.dependencies)).local).toBe("unchanged");
    expect(await treeDigest(f.root)).toEqual(after);
    const report = await doctor(f.options, f.dependencies);
    expect(
      report.checks
        .filter((item) => item.name.startsWith("Capabilities:"))
        .map((item) => item.status),
    ).toEqual(["pass", "pass"]);
    expect(result.handoff.cliStatus).toBe("complete");
    expect(result.handoff.appIntegrationComplete).toBe(false);
    expect(result.handoff.configurations).toEqual(["Debug", "Release"]);
    expect(result.handoff.tasks.some((item) => item.id === "initialize-clerk")).toBe(true);
    expect(
      result.handoff.tasks.find((item) => item.id === "optional-sign-in-ui")?.requiresUserIntent,
    ).toBe(true);
  });

test("macOS sandbox declared only in entitlements gets network access without Apple opt-in", async () => {
  const f = await fixture("macos");
  f.options.signInWithApple = false;
  const run = f.dependencies.run;
  f.dependencies.run = async (...args) => {
    const output = JSON.parse(await run(...args));
    output[0].buildSettings.ENABLE_APP_SANDBOX = "NO";
    return JSON.stringify(output);
  };
  const path = join(f.root, "MyApp/MyApp.entitlements");
  await writeFile(
    path,
    "<plist><dict><key>com.apple.security.app-sandbox</key><true/><!--keep--></dict></plist>",
  );
  const checks = (report: Awaited<ReturnType<typeof doctor>>) =>
    report.checks
      .filter((item) => item.name.startsWith("Capabilities:"))
      .map((item) => item.status);
  // Debug and Release share this file, so both report the pending change.
  expect(checks(await doctor(f.options, f.dependencies))).toEqual(["warn", "warn"]);
  const preview = await prepareSetup(f.options, f.dependencies);
  expect(preview.capabilities?.actions).toHaveLength(1);
  expect((await applySetup(preview, f.dependencies)).capabilities.status).toBe("configured");
  const source = await readFile(path, "utf8");
  expect(source).toContain("<key>com.apple.security.network.client</key><true/>");
  expect(source).toContain("<!--keep-->");
  expect(source).not.toContain("com.apple.developer.applesignin");
  expect((await prepareSetup(f.options, f.dependencies)).capabilities?.status).toBe("satisfied");
  expect(checks(await doctor(f.options, f.dependencies))).toEqual(["pass", "pass"]);
});

test.each([
  { sandbox: "<true/>", network: "<false/>", enabled: true },
  { sandbox: "<true/>", network: "<true/>", enabled: false },
  { sandbox: "<false/>", network: "<false/>", enabled: false },
])(
  "macOS networking respects existing entitlements: $sandbox / $network",
  ({ sandbox, network, enabled }) => {
    const source = `<plist><dict><key>com.apple.security.app-sandbox</key>${sandbox}<key>com.apple.security.network.client</key>${network}</dict></plist>`;
    const result = capabilityXML(source, undefined, false, true);
    expect(result).toBe(enabled ? source.replace("<false/>", "<true/>") : source);
    expect(capabilityXML(result, undefined, false, true)).toBe(result);
    expect(capabilityXML(source)).toBe(source);
  },
);

test("entitlement edits follow Xcode's tab-indented layout", () => {
  const plist = (body: string) =>
    `<?xml version="1.0" encoding="UTF-8"?>\n<plist version="1.0">\n<dict>\n${body}</dict>\n</plist>\n`;
  expect(
    capabilityXML(
      plist(
        "\t<key>com.apple.developer.associated-domains</key>\n\t<array>\n\t\t<string>applinks:example.com</string>\n\t</array>\n",
      ),
      "webcredentials:fixture.clerk.accounts.dev",
      true,
    ),
  ).toBe(
    plist(
      "\t<key>com.apple.developer.associated-domains</key>\n\t<array>\n\t\t<string>applinks:example.com</string>\n\t\t<string>webcredentials:fixture.clerk.accounts.dev</string>\n\t</array>\n" +
        "\t<key>com.apple.developer.applesignin</key>\n\t<array>\n\t\t<string>Default</string>\n\t</array>\n",
    ),
  );
});

test("malformed macOS sandbox entitlements require manual review", () => {
  expect(() =>
    capabilityXML(
      "<plist><dict><key>com.apple.security.app-sandbox</key><string>true</string></dict></plist>",
      undefined,
      false,
      true,
    ),
  ).toThrow("sandbox entitlement");
});

test("create and attach entitlements for a target without a file, then rerun", async () => {
  const f = await fixture();
  const document = parse(await readFile(f.path, "utf8"));
  delete (document.objects![ids.targetDebug] as any).buildSettings.CODE_SIGN_ENTITLEMENTS;
  await writeFile(f.path, build(document));
  const preview = await prepareSetup(f.options, f.dependencies);
  const created = preview.local.actions.find((action) => action.type === "create")!;
  expect(created).toBeDefined();
  const result = await applySetup(preview, f.dependencies);
  expect(result.apple).toBe("verified");
  expect(await readFile(join(f.root, created.path), "utf8")).toContain(
    "webcredentials:fixture.clerk.accounts.dev",
  );
  expect(
    (await applySetup(await prepareSetup(f.options, f.dependencies), f.dependencies)).local,
  ).toBe("unchanged");
});

test("shared or inherited entitlement ownership is manual and cannot activate Apple", async () => {
  for (const ownership of ["shared", "inherited", "alias"]) {
    const f = await fixture("ios", true);
    const document = parse(await readFile(f.path, "utf8"));
    const objects = document.objects as Record<string, any>;
    if (ownership === "inherited")
      // As Xcode reports a target that gets the app's entitlements from an xcconfig.
      reportOtherTarget(f, { CODE_SIGN_ENTITLEMENTS: "MyApp/MyApp.entitlements" });
    else if (ownership === "alias") {
      await symlink(join(f.root, "MyApp/MyApp.entitlements"), join(f.root, "Other.entitlements"));
      objects[ids.secondDebug].buildSettings.CODE_SIGN_ENTITLEMENTS = "Other.entitlements";
      // xcodebuild -alltargets reports the other target's setting too.
      reportOtherTarget(f, { CODE_SIGN_ENTITLEMENTS: "Other.entitlements" }, "Debug");
    } else {
      objects[ids.secondDebug].buildSettings.CODE_SIGN_ENTITLEMENTS = "MyApp/MyApp.entitlements";
      reportOtherTarget(f, { CODE_SIGN_ENTITLEMENTS: "MyApp/MyApp.entitlements" }, "Debug");
    }
    await writeFile(f.path, build(document));
    const source = await readFile(join(f.root, "MyApp/MyApp.entitlements"), "utf8");
    const preview = await prepareSetup(f.options, f.dependencies);
    expect(preview.capabilities?.status).toBe("manual");
    expect(preview.apple).toBeUndefined();
    expect((await applySetup(preview, f.dependencies)).apple).toBe("manual");
    expect(await readFile(join(f.root, "MyApp/MyApp.entitlements"), "utf8")).toBe(source);
    expect(f.state.events).toEqual(["register", "enable-native"]);
  }
});

test.each([
  { name: "no entitlements", settings: {} as Record<string, string>, manual: false },
  {
    name: "the app's entitlements",
    settings: { CODE_SIGN_ENTITLEMENTS: "MyApp/MyApp.entitlements" },
    manual: true,
  },
])(
  "another target that Xcode resolves to $name decides whether entitlements are edited",
  async ({ settings, manual }) => {
    // However the other target's value is set (directly, an xcconfig, CocoaPods), Xcode's answer decides.
    const f = await fixture("ios", true);
    reportOtherTarget(f, settings);
    const preview = await prepareSetup(f.options, f.dependencies);
    expect(preview.capabilities?.status === "manual").toBe(manual);
  },
);

test.each([undefined, "Debug"])(
  "a file another target uses only in another configuration still counts as shared (--xcode-configuration %p)",
  async (configuration) => {
    // App: Debug uses MyApp.entitlements, Release uses Release.entitlements.
    // Another target uses MyApp.entitlements only in Release, even when only Debug is selected.
    const f = await fixture("ios", true);
    f.options.configuration = configuration;
    const document = parse(await readFile(f.path, "utf8"));
    (document.objects![ids.targetRelease] as any).buildSettings.CODE_SIGN_ENTITLEMENTS =
      "MyApp/Release.entitlements";
    await writeFile(f.path, build(document));
    await writeFile(
      join(f.root, "MyApp/Release.entitlements"),
      await readFile(join(f.root, "MyApp/MyApp.entitlements"), "utf8"),
    );
    reportOtherTarget(f, { CODE_SIGN_ENTITLEMENTS: "MyApp/MyApp.entitlements" }, "Release");

    const preview = await prepareSetup(f.options, f.dependencies);
    expect(preview.capabilities?.status).toBe("manual");
    expect(preview.capabilities?.reason).toContain("shared with another target");
  },
);

test("ownership lookups for unselected configurations let each target use its own SDK", async () => {
  const f = await fixture("ios", true);
  f.options.configuration = "Debug";
  const commands: string[][] = [];
  const run = f.dependencies.run;
  f.dependencies.run = async (command, root, signal) => {
    commands.push(command);
    return run(command, root, signal);
  };
  await prepareSetup(f.options, f.dependencies);
  const release = commands.filter((command) => command.includes("Release"));
  expect(release.length).toBeGreaterThan(0);
  for (const command of release) expect(command).not.toContain("-sdk");
});

test("a selected configuration falls back to manual setup when Xcode can't report the others", async () => {
  const f = await fixture("ios", true);
  f.options.configuration = "Debug";
  const run = f.dependencies.run;
  f.dependencies.run = async (command, root, signal) => {
    if (command.includes("Release")) throw new Error("xcodebuild failed");
    return run(command, root, signal);
  };
  const preview = await prepareSetup(f.options, f.dependencies);
  expect(preview.capabilities?.status).toBe("manual");
  expect(preview.capabilities?.reason).toContain("couldn't report every configuration");
});

test("another target's variable entitlements path doesn't block setup when Xcode resolves it elsewhere", async () => {
  const f = await fixture("ios", true);
  const document = parse(await readFile(f.path, "utf8"));
  for (const id of [ids.secondDebug, ids.secondRelease])
    (document.objects![id] as any).buildSettings.CODE_SIGN_ENTITLEMENTS =
      "$(SRCROOT)/AdminApp/AdminApp.entitlements";
  await writeFile(f.path, build(document));
  reportOtherTarget(f, { CODE_SIGN_ENTITLEMENTS: "AdminApp/AdminApp.entitlements" });

  const preview = await prepareSetup(f.options, f.dependencies);
  expect(preview.capabilities?.status).toBe("planned");
});

test("stale entitlements and new-file collisions stop before any writes", async () => {
  for (const fresh of [false, true]) {
    const f = await fixture();
    if (fresh) {
      const graph = parse(await readFile(f.path, "utf8"));
      delete (graph.objects![ids.targetDebug] as any).buildSettings.CODE_SIGN_ENTITLEMENTS;
      await writeFile(f.path, build(graph));
    }
    const preview = await prepareSetup(f.options, f.dependencies);
    const file = preview.capabilities!.actions[0]!;
    await writeFile(join(f.root, file.path), "user edit");
    const source = await readFile(f.path, "utf8");
    await expect(applySetup(preview, f.dependencies)).rejects.toThrow();
    expect(f.state.events).toEqual([]);
    expect(await readFile(f.path, "utf8")).toBe(source);
  }
});

test("registration casing conflicts block before local edits or Apple activation", async () => {
  const f = await fixture();
  f.options.remote = { applicationId: "app_test" };
  f.state.apps.push({
    object: "ios_application",
    id: "ios_existing",
    bundle_id: "com.example.myapp",
    app_id_prefix: "TEST123456",
  });
  const before = await treeDigest(f.root);
  await expect(prepareSetup(f.options, f.dependencies)).rejects.toThrow(
    'Bundle ID "com.example.MyApp" differs in capitalization from Clerk registration "com.example.myapp"',
  );
  expect(await treeDigest(f.root)).toEqual(before);
  expect(f.state.events).toEqual([]);
});

test("an existing conflicting Apple identity blocks planning; interrupted Apple activation recovers", async () => {
  const f = await fixture();
  f.state.apple.bundle_id = "com.other.App";
  await expect(prepareSetup(f.options, f.dependencies)).rejects.toThrow("Apple connection");
  delete f.state.apple.bundle_id;
  f.state.failApple = true;
  expect(
    (await applySetup(await prepareSetup(f.options, f.dependencies), f.dependencies)).apple,
  ).toBe("incomplete");
  f.state.failApple = false;
  expect(
    (await applySetup(await prepareSetup(f.options, f.dependencies), f.dependencies)).apple,
  ).toBe("verified");
  expect(f.state.events.filter((event) => event === "register")).toHaveLength(1);
});

test("capabilities alone never opt into Apple and handoff alone performs no work", async () => {
  const f = await fixture();
  f.options.signInWithApple = false;
  const preview = await prepareSetup(f.options, f.dependencies);
  expect(preview.apple).toBeUndefined();
  const before = await treeDigest(f.root);
  const handoff = integrationHandoff(preview.inspection.input.selection, "core", key);
  expect(handoff.publishableKey).toBe(key);
  expect(handoff.tasks.map((task) => task.status)).toEqual([
    "pending",
    "pending",
    "pending",
    "pending",
    "unverified",
  ]);
  expect(JSON.stringify(handoff)).not.toContain("AuthView()");
  expect(await treeDigest(f.root)).toEqual(before);
  expect(f.state.events).toEqual([]);
});

test.each([
  { answer: undefined, entitlement: true, warned: false },
  { answer: false, entitlement: false, warned: true },
])(
  "Apple enabled in Clerk adds the entitlement only when the user wasn't asked (answer: $answer)",
  async ({ answer, entitlement, warned }) => {
    const f = await fixture();
    f.state.apple.enabled = true;
    f.options.signInWithApple = answer;
    f.options.checkAppleConnection = true;
    const preview = await prepareSetup(f.options, f.dependencies);
    expect(preview.capabilities?.appleEntitlement).toBe(entitlement);
    expect(preview.appleWarning?.includes("capability was not added") ?? false).toBe(warned);
  },
);

test("a later project-write failure restores earlier entitlement edits and attempts no remote mutation", async () => {
  const f = await fixture();
  await useStarterSources(f.root);
  const preview = await prepareSetup({ ...f.options, signInUI: true }, f.dependencies);
  const originalApp = await readFile(join(f.root, "MyApp/MyAppApp.swift"), "utf8");
  const originalView = await readFile(join(f.root, "MyApp/ContentView.swift"), "utf8");
  const originalProject = await readFile(f.path, "utf8");
  const originalEntitlements = await readFile(join(f.root, "MyApp/MyApp.entitlements"), "utf8");
  const directory = join(f.root, "MyApp.xcodeproj");
  await chmod(directory, 0o500);
  try {
    const result = await applySetup(preview, f.dependencies);
    expect(result.local).toBe("incomplete");
    expect(result.handoff.cliStatus).toBe("incomplete");
    expect(result.handoff.completed).toEqual([]);
    expect(result.handoff.changedFiles).toEqual(result.changedFiles);
    expect(result.changedFiles).toEqual([]);
    expect(result.recovery).toEqual({
      restored: ["MyApp/ContentView.swift", "MyApp/MyAppApp.swift", "MyApp/MyApp.entitlements"],
      needsReview: [],
    });
    expect(await readFile(join(f.root, "MyApp/MyApp.entitlements"), "utf8")).toBe(
      originalEntitlements,
    );
    expect(result.backups).toHaveLength(3);
    expect(await readFile(join(f.root, "MyApp/MyAppApp.swift"), "utf8")).toBe(originalApp);
    expect(await readFile(join(f.root, "MyApp/ContentView.swift"), "utf8")).toBe(originalView);
    expect(f.state.events).toEqual([]);
    expect(await readFile(f.path, "utf8")).toBe(originalProject);
  } finally {
    await chmod(directory, 0o700);
  }
});

test("entitlement editing preserves unrelated XML and rejects malformed or conflicting values", () => {
  const source =
    '<plist version="1.0"><dict><!--keep--><key>custom</key><data>YWJj</data><key>com.apple.developer.associated-domains</key><array><string>applinks:example.com</string></array></dict></plist>';
  const next = capabilityXML(source, "webcredentials:fixture.clerk.accounts.dev", true);
  expect(next).toContain("<!--keep-->");
  expect(next).toContain("<data>YWJj</data>");
  expect(next).toContain("applinks:example.com");
  expect(capabilityXML(next, "webcredentials:fixture.clerk.accounts.dev", true)).toBe(next);
  for (const body of [
    "<key>x</key><true/>unexpected text",
    "<key>x</key><true/><key>x</key><false/>",
    "<key>com.apple.developer.associated-domains</key><string>wrong type</string>",
    "<key>com.apple.developer.applesignin</key><array><string>Unknown</string></array>",
  ])
    expect(() =>
      capabilityXML(`<plist><dict>${body}</dict></plist>`, "webcredentials:example.com", true),
    ).toThrow();
});

test("Doctor checks an already-enabled Apple provider without mutation opt-in and identifies Release-only gaps", async () => {
  const f = await fixture();
  await applySetup(await prepareSetup(f.options, f.dependencies), f.dependencies);
  const document = parse(await readFile(f.path, "utf8"));
  (document.objects![ids.targetRelease] as any).buildSettings.CODE_SIGN_ENTITLEMENTS =
    "MyApp/Release.entitlements";
  await writeFile(
    join(f.root, "MyApp/Release.entitlements"),
    '<plist version="1.0"><dict/></plist>',
  );
  await writeFile(f.path, build(document));
  const before = await treeDigest(f.root);
  const events = [...f.state.events];
  const report = await doctor(
    { ...f.options, capabilities: false, signInWithApple: false },
    f.dependencies,
  );
  expect(report.checks.find((item) => item.name === "Apple entitlement: Debug")?.status).toBe(
    "pass",
  );
  expect(report.checks.find((item) => item.name === "Apple entitlement: Release")).toMatchObject({
    status: "fail",
    message: expect.stringContaining("Release has no Apple entitlement"),
  });
  expect(report.status).toBe("failed");
  expect(f.state.events).toEqual(events);
  expect(await treeDigest(f.root)).toEqual(before);
});

test("explicit configuration selection reports remaining coverage and Release inspection failure never writes", async () => {
  const f = await fixture();
  const preview = await prepareSetup({ ...f.options, configuration: "Debug" }, f.dependencies);
  expect(describePreview(preview).coverage.uncheckedConfigurations).toEqual(["Release"]);
  const before = await treeDigest(f.root);
  const run: CommandRunner = async (command, root, signal) => {
    if (command.includes("Release")) throw new Error("Synthetic Release failure");
    return f.dependencies.run(command, root, signal);
  };
  await expect(prepareSetup(f.options, { ...f.dependencies, run })).rejects.toThrow(
    "Release failure",
  );
  expect(await treeDigest(f.root)).toEqual(before);
  expect(f.state.events).toEqual([]);
  const result = await applySetup(preview, f.dependencies);
  expect(result.handoff.cliStatus).toBe("manual-steps-required");
  expect(result.handoff.remaining.some((item) => item.id === "configuration: Release")).toBe(true);
});

for (const platform of ["ios", "macos"] as const)
  test(`${platform}: new matching configurations share a readable entitlement file and rerun without changes`, async () => {
    const f = await fixture(platform);
    const document = parse(await readFile(f.path, "utf8"));
    for (const id of [ids.targetDebug, ids.targetRelease])
      delete (document.objects![id] as any).buildSettings.CODE_SIGN_ENTITLEMENTS;
    await writeFile(f.path, build(document));
    const preview = await prepareSetup(f.options, f.dependencies);
    const created = preview.local.actions.filter((action) => action.type === "create");
    expect(created).toHaveLength(1);
    expect(created[0]!.path).toBe(
      platform === "ios" ? "MyApp.entitlements" : "MyApp-macOS.entitlements",
    );
    const result = await applySetup(preview, f.dependencies);
    expect(new Set(result.changedFiles).size).toBe(2);
    expect(result.handoff.cliStatus).toBe("complete");
    expect((await prepareSetup(f.options, f.dependencies)).capabilities?.status).toBe("satisfied");
  });

test("readable entitlement names do not adopt existing files or another target's missing file", async () => {
  for (const existingFile of [true, false]) {
    const f = await fixture("ios", true);
    const document = parse(await readFile(f.path, "utf8"));
    const objects = document.objects as Record<string, any>;
    for (const id of [ids.targetDebug, ids.targetRelease])
      delete objects[id].buildSettings.CODE_SIGN_ENTITLEMENTS;
    if (existingFile) await writeFile(join(f.root, "MyApp.entitlements"), "existing user file");
    else objects[ids.secondDebug].buildSettings.CODE_SIGN_ENTITLEMENTS = "MyApp.entitlements";
    await writeFile(f.path, build(document));
    const before = await treeDigest(f.root);
    const preview = await prepareSetup(f.options, f.dependencies);
    expect(preview.capabilities?.status).toBe("manual");
    expect(preview.capabilities?.actions).toEqual([]);
    expect(await treeDigest(f.root)).toEqual(before);
  }
});

test("existing separate configuration entitlements remain separate", async () => {
  const f = await fixture();
  const document = parse(await readFile(f.path, "utf8"));
  (document.objects![ids.targetRelease] as any).buildSettings.CODE_SIGN_ENTITLEMENTS =
    "MyApp/Release.entitlements";
  await writeFile(
    join(f.root, "MyApp/Release.entitlements"),
    "<plist><dict><key>custom-release-setting</key><true/></dict></plist>",
  );
  await writeFile(f.path, build(document));
  const preview = await prepareSetup(f.options, f.dependencies);
  expect(preview.capabilities?.actions.map((action) => action.path)).toEqual([
    "MyApp/MyApp.entitlements",
    "MyApp/Release.entitlements",
  ]);
  await applySetup(preview, f.dependencies);
  expect(await readFile(join(f.root, "MyApp/Release.entitlements"), "utf8")).toContain(
    "custom-release-setting",
  );
  expect((await prepareSetup(f.options, f.dependencies)).capabilities?.status).toBe("satisfied");
});

for (const signInUI of [false, true])
  test(`unchanged starter is initialized; optional UI intent=${signInUI}`, async () => {
    const f = await fixture();
    await useStarterSources(f.root);
    const viewBefore = await readFile(join(f.root, "MyApp/ContentView.swift"), "utf8");
    const preview = await prepareSetup({ ...f.options, signInUI }, f.dependencies);
    expect(preview.starter?.actions).toHaveLength(signInUI ? 2 : 1);
    const result = await applySetup(preview, f.dependencies);
    expect(result.status).toBe("requires-build-and-verification");
    expect(result.handoff.tasks.find((task) => task.id === "initialize-clerk")?.status).toBe(
      "completed",
    );
    const app = await readFile(join(f.root, "MyApp/MyAppApp.swift"), "utf8");
    expect(app).toContain("// Preserve the project header");
    expect(app).toContain("Clerk.configure");
    expect(app).toContain(".environment(Clerk.shared)");
    const view = await readFile(join(f.root, "MyApp/ContentView.swift"), "utf8");
    if (signInUI) {
      expect(view).toContain('    Button("Sign in") {\n                authIsPresented = true');
      expect(view).toContain(
        "#Preview {\n    ContentView()\n        .environment(Clerk.preview())\n}",
      );
    } else expect(view).toBe(viewBefore);
    expect(
      (await prepareSetup({ ...f.options, signInUI }, f.dependencies)).starter?.actions,
    ).toEqual([]);
  });
