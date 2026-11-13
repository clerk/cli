/**
 * Runs native setup on Xcode Multiplatform App targets (one target for iOS and macOS,
 * `SDKROOT = auto`) with actual Xcode and a fake Clerk API.
 *
 * Without options it covers, in disposable fixtures: a shared entitlements file and none,
 * each for a paid team and a Personal Team, checked with Xcode before and after the
 * capability edits; then full setup with package resolution and an unsigned Debug build
 * for iOS Simulator and macOS. With `--project`, it runs full setup and both builds on a
 * copy of that project instead; the original is never modified.
 *
 * Usage:
 *   bun scripts/apple-setup/verify-multiplatform.ts
 *   bun scripts/apple-setup/verify-multiplatform.ts --project ~/Developer/MyApp
 *   bun scripts/apple-setup/verify-multiplatform.ts --project ~/Developer/MyApp --personal-team --shared-entitlements
 */
import { build, parse } from "@bacons/xcode/json";
import { cp, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import {
  createIOSFixture,
  IOS_FIXTURE_IDS as ids,
} from "../../packages/cli-core/src/commands/init/ios/test-helpers.ts";
import { useStarterSources } from "../../packages/cli-core/src/commands/init/ios/setup-test-helpers.ts";
import { planAllCapabilities } from "../../packages/cli-core/src/commands/init/ios/capabilities.ts";
import { createFile, replaceProject } from "../../packages/cli-core/src/commands/init/ios/files.ts";
import {
  applySetup,
  prepareSetup,
  type SetupOptions,
} from "../../packages/cli-core/src/commands/init/ios/workflow.ts";
import { doctor } from "../../packages/cli-core/src/commands/init/ios/doctor.ts";
import { signedByPersonalTeam } from "../../packages/cli-core/src/commands/init/ios/teams.ts";
import {
  inspectSelectedProject,
  type Inspection,
} from "../../packages/cli-core/src/commands/init/ios/xcode.ts";
import type { NativeAPI } from "../../packages/cli-core/src/commands/init/ios/remote.ts";
import type { IOSNativeAppleAPI } from "../../packages/cli-core/src/commands/init/ios/native-apple.ts";
import type { IOSApplication } from "../../packages/cli-core/src/lib/plapi.ts";

const { values } = parseArgs({
  options: {
    project: { type: "string" },
    "personal-team": { type: "boolean", default: false },
    "shared-entitlements": { type: "boolean", default: false },
  },
  strict: true,
});
if ((values["personal-team"] || values["shared-entitlements"]) && !values.project) {
  throw new Error("--personal-team and --shared-entitlements apply to --project.");
}

const HOST = "fixture.clerk.accounts.dev";
const DOMAIN = `webcredentials:${HOST}`;
const SANDBOX_ENTITLEMENTS = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
\t<key>com.apple.security.app-sandbox</key>
\t<true/>
\t<key>com.apple.security.files.user-selected.read-only</key>
\t<true/>
</dict>
</plist>
`;

function fakeClerk() {
  const applications: IOSApplication[] = [];
  let enabled = false;
  const api: NativeAPI = {
    async fetchApplication(applicationId) {
      return {
        application_id: applicationId,
        instances: [
          {
            instance_id: "ins_fixture",
            environment_type: "development",
            publishable_key: `pk_test_${btoa(`${HOST}$`)}`,
          },
        ],
      };
    },
    async getNativeSettings() {
      return { object: "native_settings", api_enabled: enabled };
    },
    async listIOSApplications() {
      return [...applications];
    },
    async createIOSApplication(_app, _instance, params) {
      const application: IOSApplication = {
        object: "ios_application",
        id: `ios_${applications.length}`,
        bundle_id: params.bundle_id,
        app_id_prefix: params.app_id_prefix,
      };
      applications.push(application);
      return application;
    },
    async enableNativeApi() {
      enabled = true;
      return { object: "native_settings", api_enabled: true };
    },
  };
  const appleAPI: IOSNativeAppleAPI = {
    async fetchInstanceConfig() {
      return {
        connection_oauth_apple: { enabled: false, authenticatable: true },
        config_version: "v1_1234abcd",
      };
    },
    async fetchInstanceConfigSchema() {
      return { properties: {} };
    },
    async patchInstanceConfig() {
      throw new Error("This probe never writes the Apple connection.");
    },
  };
  return { api, appleAPI, applications };
}

async function lint(path: string): Promise<void> {
  const child = Bun.spawn(["plutil", "-lint", path], { stdout: "pipe", stderr: "pipe" });
  const [output, , code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code !== 0) throw new Error(`plutil rejected ${path}: ${output}`);
}

/** Checks what Xcode resolves per platform after setup: which file each signs with, and its entries. */
async function checkResolved(inspection: Inspection, personal: boolean) {
  if (
    inspection.contexts.map((context) => context.selection.sdk).join() !==
    "iphoneos,macosx,iphoneos,macosx"
  )
    throw new Error("Xcode did not resolve Debug and Release for both iOS and macOS.");
  const files: Record<string, string> = {};
  for (const { selection, settings } of inspection.contexts) {
    const path = settings.CODE_SIGN_ENTITLEMENTS;
    const mac = selection.sdk === "macosx";
    if (mac && settings.ENABLE_OUTGOING_NETWORK_CONNECTIONS !== "YES")
      throw new Error(`${selection.configuration}/macOS lacks outgoing network access.`);
    // A Personal Team's Mac build needs no entries a file would add, so it may sign without one.
    if (!path && personal && mac) {
      files.macOS = "none";
      continue;
    }
    if (!path) throw new Error(`${selection.configuration}/${selection.sdk} has no entitlements.`);
    const absolute = resolve(settings.SRCROOT!, path);
    await lint(absolute);
    const source = await readFile(absolute, "utf8");
    if (source.includes(DOMAIN) !== !(personal && mac))
      throw new Error(
        `${selection.configuration}/${selection.sdk}: Associated Domain ${personal && mac ? "present" : "missing"} in ${path}.`,
      );
    files[mac ? "macOS" : "iOS"] = path;
  }
  return files;
}

async function buildPlatforms(projectRoot: string, project: string, scheme: string, root: string) {
  const builds: Record<string, string> = {};
  for (const [platform, destination] of [
    ["iOS Simulator", "generic/platform=iOS Simulator"],
    ["macOS", "generic/platform=macOS"],
  ] as const) {
    const buildLog = `/tmp/clerk-setup-build-multiplatform-${platform.replace(" ", "-")}.log`;
    const child = Bun.spawn(
      [
        "xcodebuild",
        "-project",
        join(projectRoot, project),
        "-scheme",
        scheme,
        "-configuration",
        "Debug",
        "-destination",
        destination,
        "-derivedDataPath",
        join(root, "DerivedData"),
        "CODE_SIGNING_ALLOWED=NO",
        "build",
      ],
      {
        stdout: Bun.file(buildLog),
        stderr: Bun.file(`${buildLog}.stderr`),
        timeout: 900_000,
      },
    );
    if ((await child.exited) !== 0)
      throw new Error(`${platform} build failed: ${buildLog} and ${buildLog}.stderr`);
    builds[platform] = `passed (${buildLog})`;
  }
  return builds;
}

/** Points every configuration of the app target at one sandboxed file, as Xcode's pre-27 template did. */
async function shareEntitlements(projectRoot: string, project: string, target: string) {
  const path = join(projectRoot, project, "project.pbxproj");
  const graph = parse(await readFile(path, "utf8"));
  const objects = graph.objects as Record<string, any>;
  const targetObject = Object.values(objects).find(
    (item) => item.isa === "PBXNativeTarget" && item.name === target,
  );
  for (const id of objects[targetObject.buildConfigurationList].buildConfigurations)
    objects[id].buildSettings.CODE_SIGN_ENTITLEMENTS = `${target}/${target}.entitlements`;
  await writeFile(path, build(graph));
  await writeFile(join(projectRoot, target, `${target}.entitlements`), SANDBOX_ENTITLEMENTS);
}

/** Full setup with package resolution, then Xcode's view of the result and both builds. */
async function fullSetup(projectRoot: string, personal: boolean, root: string) {
  const clerk = fakeClerk();
  const before = await inspectSelectedProject({
    root: projectRoot,
    products: "ui",
    minimumVersion: "1.5.8",
  });
  // As clerk init and doctor do, the signing team decides; Xcode's account list says if it's personal.
  const xcodeTeams = [
    {
      id: before.contexts[0]!.settings.DEVELOPMENT_TEAM ?? "TEAMID0000",
      name: "Fixture",
      personal,
    },
  ];
  if (signedByPersonalTeam(before, xcodeTeams) !== personal)
    throw new Error("The project has no signing team to mark as a Personal Team.");
  const options: SetupOptions = {
    root: projectRoot,
    products: "ui",
    minimumVersion: "1.5.8",
    resolvePackages: true,
    capabilities: true,
    signInUI: true,
    signInWithApple: false,
    personalTeam: personal,
    remote: { applicationId: "app_fixture", appIdPrefix: "TEST123456" },
    progress: (message) => console.log(message),
  };
  const dependencies = { api: clerk.api, appleAPI: clerk.appleAPI, xcodeTeams };
  const preview = await prepareSetup(options, dependencies);
  if (preview.capabilities?.status !== "planned")
    throw new Error(`Capabilities unavailable: ${preview.capabilities?.reason}`);
  const result = await applySetup(preview, dependencies);
  if (result.local !== "updated" || result.remote !== "verified" || result.packages !== "resolved")
    throw new Error(result.message ?? `Setup did not complete: ${result.status}`);
  if (clerk.applications.length !== 1)
    throw new Error("One registration should cover both platforms.");
  if (personal !== result.handoff.remaining.some((item) => item.id === "associated-domains"))
    throw new Error("The Personal Team note for the Mac side is wrong.");
  const after = await inspectSelectedProject({ ...options, resolvePackages: false });
  const files = await checkResolved(after, personal);
  const rerun = await prepareSetup({ ...options, resolvePackages: false }, dependencies);
  if (rerun.local.actions.some((action) => action.type !== "skip"))
    throw new Error("A rerun planned more changes.");
  const report = await doctor({ ...options, resolvePackages: false }, dependencies);
  const unfinished = report.checks.filter(
    (check) => check.name.startsWith("Capabilities:") && check.status !== "pass",
  );
  if (unfinished.length) throw new Error(`Doctor found capability gaps: ${unfinished[0]!.message}`);
  const { project, targetName } = after.input.selection;
  return {
    target: targetName,
    platforms: after.contexts.map((c) => `${c.selection.configuration}/${c.selection.sdk}`),
    unsupportedPlatforms: after.unsupportedPlatforms,
    entitlements: files,
    changedFiles: result.changedFiles,
    registration: `${clerk.applications[0]!.app_id_prefix}.${clerk.applications[0]!.bundle_id}`,
    rerun: "no changes",
    doctor: "capabilities pass on every configuration and platform",
    builds: await buildPlatforms(projectRoot, project, targetName, root),
  };
}

async function verifyProject(path: string) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "clerk-multiplatform-project-")));
  try {
    const projectRoot = join(root, basename(resolve(path)));
    await cp(resolve(path), projectRoot, { recursive: true });
    if (values["shared-entitlements"]) {
      const inspection = await inspectSelectedProject({
        root: projectRoot,
        products: "ui",
        minimumVersion: "1.5.8",
      });
      const { project, targetName } = inspection.input.selection;
      await shareEntitlements(projectRoot, project, targetName);
    }
    console.log(
      JSON.stringify({
        project: path,
        copy: projectRoot,
        personalTeam: values["personal-team"],
        sharedEntitlements: values["shared-entitlements"],
        ...(await fullSetup(projectRoot, values["personal-team"]!, root)),
        scope: "Unsigned builds; fake Clerk API; no provisioning or actual sign-in",
      }),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function verifyFixtures() {
  // Capability edits only (no SDK, so Xcode reports settings without package resolution).
  for (const shared of [true, false])
    for (const personal of [false, true]) {
      const root = await realpath(await mkdtemp(join(tmpdir(), "clerk-multiplatform-xcode-")));
      try {
        await createIOSFixture(root, {
          platform: "multiplatform",
          clerkSDK: false,
          includeKey: false,
        });
        if (!shared) {
          const path = join(root, "MyApp.xcodeproj/project.pbxproj");
          const graph = parse(await readFile(path, "utf8"));
          for (const id of [ids.targetDebug, ids.targetRelease])
            delete (graph.objects![id] as any).buildSettings.CODE_SIGN_ENTITLEMENTS;
          await writeFile(path, build(graph));
        }
        const options = { root, products: "ui" as const, minimumVersion: "1.0.0" };
        const inspection = await inspectSelectedProject(options);
        if (inspection.unsupportedPlatforms.join() !== "visionOS")
          throw new Error("visionOS was not reported as left alone.");
        const domainFor = (selection: { sdk: string }) => !(personal && selection.sdk === "macosx");
        const plan = await planAllCapabilities(
          inspection,
          inspection.document.source,
          HOST,
          !personal,
          domainFor,
        );
        if (plan.status !== "planned")
          throw new Error(`Capability plan unavailable: ${plan.reason}`);
        for (const action of plan.actions) {
          if (action.type === "create") await createFile(root, action.path, action.content);
          else if (action.type === "modify")
            await replaceProject(
              root,
              plan.snapshots.find((snapshot) => snapshot.path === action.path)!,
              action.content,
            );
        }
        await replaceProject(root, inspection.document, plan.projectSource);
        const after = await inspectSelectedProject(options);
        const files = await checkResolved(after, personal);
        const expected = {
          iOS: shared ? "MyApp/MyApp.entitlements" : "MyApp.entitlements",
          macOS: !personal
            ? shared
              ? "MyApp/MyApp.entitlements"
              : "MyApp.entitlements"
            : shared
              ? "MyApp/MyApp-macOS.entitlements"
              : "none",
        };
        if (JSON.stringify(files) !== JSON.stringify(expected))
          throw new Error(`Unexpected entitlement layout: ${JSON.stringify(files)}`);
        if (
          shared &&
          personal &&
          !(await readFile(join(root, files.macOS!), "utf8")).includes(
            "com.apple.security.files.user-selected.read-only",
          )
        )
          throw new Error("The Mac copy lost an entitlement the shared file had.");
        const next = await planAllCapabilities(
          after,
          after.document.source,
          HOST,
          !personal,
          domainFor,
        );
        if (next.status !== "satisfied" || next.actions.length)
          throw new Error("Capability setup was not idempotent.");
        console.log(
          JSON.stringify({
            entitlements: shared ? "shared file" : "none",
            team: personal ? "personal" : "paid",
            resolvedByXcode: files,
            xcodeBeforeAndAfter: "passed",
            plistValidation: "passed",
            rerun: "no changes",
          }),
        );
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    }

  // Full setup and both builds on the fixture: the split, and the template without a file.
  for (const [shared, personal] of [
    [true, true],
    [false, false],
  ] as const) {
    const root = await realpath(await mkdtemp(join(tmpdir(), "clerk-multiplatform-build-")));
    try {
      const projectRoot = join(root, "MyApp");
      await createIOSFixture(projectRoot, {
        platform: "multiplatform",
        clerkSDK: false,
        includeKey: false,
      });
      await useStarterSources(projectRoot);
      if (!shared) {
        const path = join(projectRoot, "MyApp.xcodeproj/project.pbxproj");
        const graph = parse(await readFile(path, "utf8"));
        for (const id of [ids.targetDebug, ids.targetRelease])
          delete (graph.objects![id] as any).buildSettings.CODE_SIGN_ENTITLEMENTS;
        await writeFile(path, build(graph));
      }
      console.log(
        JSON.stringify({
          fixture: shared ? "shared entitlements file" : "no entitlements file",
          team: personal ? "personal" : "paid",
          ...(await fullSetup(projectRoot, personal, root)),
          scope: "Unsigned builds; fake Clerk API; no provisioning or actual sign-in",
        }),
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
}

if (values.project) await verifyProject(values.project);
else await verifyFixtures();
