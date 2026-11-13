import { build, parse } from "@bacons/xcode/json";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createIOSFixture,
  IOS_FIXTURE_IDS as ids,
} from "../../packages/cli-core/src/commands/init/ios/test-helpers.ts";
import { planAllCapabilities } from "../../packages/cli-core/src/commands/init/ios/capabilities.ts";
import {
  convertFixtureToXCProj,
  useSynchronizedFolder,
} from "../../packages/cli-core/src/commands/init/ios/setup-test-helpers.ts";
import { applyXCProjValue } from "../../packages/cli-core/src/commands/init/ios/xcproj.ts";
import { createFile, replaceProject } from "../../packages/cli-core/src/commands/init/ios/files.ts";
import { inspectSelectedProject } from "../../packages/cli-core/src/commands/init/ios/xcode.ts";
import { compatibleXcode } from "../../packages/cli-core/src/commands/init/ios/xcode-tools.ts";

async function run(command: string[], env?: Record<string, string>): Promise<string> {
  const child = Bun.spawn(command, {
    stdout: "pipe",
    stderr: "pipe",
    timeout: 600_000,
    env: { ...process.env, ...env },
  });
  const [output, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code !== 0) throw new Error(`${command[0]} failed:\n${output.slice(-2000)}${stderr}`);
  return output;
}

// The simulator build signs locally (ad hoc) and carries the entitlements in the executable's
// __entitlements section. A Mac app with restricted entitlements needs a provisioning profile to
// sign, so it's built unsigned, which checks only what Xcode bundles.
async function buildApp(
  root: string,
  format: "pbxproj" | "xcproj",
  platform: "ios" | "macos",
): Promise<{ entitlements?: string; bundledEntitlementFiles: string[] }> {
  const developerDir = await compatibleXcode(format === "xcproj" ? 27 : 1);
  const products = join(root, "build");
  await run(
    [
      "xcodebuild",
      "-project",
      join(root, "MyApp.xcodeproj"),
      "-target",
      "MyApp",
      "-configuration",
      "Debug",
      "-sdk",
      platform === "ios" ? "iphonesimulator" : "macosx",
      "ARCHS=arm64",
      `SYMROOT=${products}`,
      "PRODUCT_NAME=MyApp",
      "SWIFT_VERSION=6.0",
      ...(platform === "ios"
        ? ["CODE_SIGN_IDENTITY=-", "CODE_SIGN_STYLE=Manual", "DEVELOPMENT_TEAM="]
        : ["CODE_SIGNING_ALLOWED=NO"]),
      "build",
    ],
    developerDir ? { DEVELOPER_DIR: developerDir } : undefined,
  );
  const app = join(products, platform === "ios" ? "Debug-iphonesimulator" : "Debug", "MyApp.app");
  const bundledEntitlementFiles = await Array.fromAsync(
    new Bun.Glob("**/*.entitlements").scan({ cwd: app, dot: true }),
  );
  if (platform === "macos") return { bundledEntitlementFiles };
  const section = join(root, "entitlements-section.plist");
  await run(["segedit", join(app, "MyApp"), "-extract", "__TEXT", "__entitlements", section]);
  return { entitlements: await readFile(section, "utf8"), bundledEntitlementFiles };
}

// Real Xcode before AND after capability edits, with no SDK dependencies attached. A JSON
// project's member folder is its synchronized folder.
for (const { format, synchronized } of [
  { format: "pbxproj", synchronized: false },
  { format: "pbxproj", synchronized: true },
  { format: "xcproj", synchronized: true },
] as const)
  for (const platform of ["ios", "macos"] as const)
    for (const createEntitlements of [false, true]) {
      const root = await realpath(await mkdtemp(join(tmpdir(), "clerk-capability-xcode-")));
      try {
        await createIOSFixture(root, {
          platform,
          clerkSDK: false,
          includeKey: false,
          macOSAppleEntitlement: false,
        });
        if (format === "xcproj") await convertFixtureToXCProj(root, platform);
        else if (synchronized) await useSynchronizedFolder(root);
        const document = join(root, `MyApp.xcodeproj/project.${format}`);
        const expected = `${synchronized ? "MyApp/" : ""}MyApp${platform === "macos" ? "-macOS" : ""}.entitlements`;
        if (createEntitlements) {
          if (synchronized) await rm(join(root, "MyApp/MyApp.entitlements"));
          let source = await readFile(document, "utf8");
          if (format === "pbxproj") {
            const graph = parse(source);
            for (const id of [ids.targetDebug, ids.targetRelease])
              delete (graph.objects![id] as any).buildSettings.CODE_SIGN_ENTITLEMENTS;
            source = build(graph);
          } else
            source = applyXCProjValue(
              source,
              ["targets", 0, "build-settings", "CODE_SIGN_ENTITLEMENTS"],
              undefined,
            );
          await writeFile(document, source);
        }
        const options = { root, products: "ui" as const, minimumVersion: "1.0.0" };
        const inspection = await inspectSelectedProject(options);
        if (!inspection.settings.DEVELOPER_DIR?.startsWith("/"))
          throw new Error("Xcode did not report the developer directory needed by the handoff.");
        const plan = await planAllCapabilities(
          inspection,
          inspection.document.source,
          "fixture.clerk.accounts.dev",
          true,
        );
        if (plan.status !== "planned")
          throw new Error(`Capability plan unavailable: ${plan.reason}`);
        if (plan.actions.length !== 1)
          throw new Error("Matching configurations should share one entitlement file.");
        if (createEntitlements && plan.actions[0]!.path !== expected)
          throw new Error(`New entitlements went to ${plan.actions[0]!.path}, not ${expected}.`);
        for (const action of plan.actions) {
          if (action.type === "create") await createFile(root, action.path, action.content);
          else if (action.type === "modify")
            await replaceProject(
              root,
              plan.snapshots.find((snapshot) => snapshot.path === action.path)!,
              action.content,
            );
        }
        if (plan.projectSource !== inspection.document.source)
          await replaceProject(root, inspection.document, plan.projectSource);
        const after = await inspectSelectedProject(options);
        if (new Set(after.contexts.map((c) => c.settings.CODE_SIGN_ENTITLEMENTS)).size !== 1)
          throw new Error("Xcode did not resolve a shared entitlement file for Debug and Release.");
        for (const context of after.contexts) {
          if (
            platform === "macos" &&
            context.settings.ENABLE_OUTGOING_NETWORK_CONNECTIONS !== "YES"
          )
            throw new Error(
              `Xcode did not resolve outgoing network access for ${format}/${context.selection.configuration}.`,
            );
          if (!context.settings.CODE_SIGN_ENTITLEMENTS)
            throw new Error("Xcode did not resolve the entitlement file.");
          const lint = Bun.spawn(
            ["plutil", "-lint", join(root, context.settings.CODE_SIGN_ENTITLEMENTS)],
            { stdout: "pipe", stderr: "pipe" },
          );
          const [, , code] = await Promise.all([
            new Response(lint.stdout).text(),
            new Response(lint.stderr).text(),
            lint.exited,
          ]);
          if (code !== 0) throw new Error("Edited entitlements did not pass plutil validation.");
        }
        const next = await planAllCapabilities(
          after,
          after.document.source,
          "fixture.clerk.accounts.dev",
          true,
        );
        if (next.status !== "satisfied" || next.actions.length)
          throw new Error("Capability setup was not idempotent.");
        const app = await buildApp(root, format, platform);
        if (
          app.entitlements !== undefined &&
          !app.entitlements.includes("webcredentials:fixture.clerk.accounts.dev")
        )
          throw new Error("The built app wasn't signed with the edited entitlements.");
        if (app.bundledEntitlementFiles.length)
          throw new Error(`Xcode copied ${app.bundledEntitlementFiles} into the app bundle.`);
        const child = Bun.spawn(
          [
            process.execPath,
            join(import.meta.dir, "../../packages/cli-core/src/cli.ts"),
            "init",
            "--dry-run",
            "--json",
          ],
          { cwd: root, stdout: "pipe", stderr: "pipe", timeout: 30_000 },
        );
        const [output, , exit] = await Promise.all([
          new Response(child.stdout).text(),
          new Response(child.stderr).text(),
          child.exited,
        ]);
        if (exit !== 0 || JSON.parse(output).mode !== "read-only")
          throw new Error("Public dry run did not return structured JSON.");
        console.log(
          JSON.stringify({
            platform,
            format,
            sources: synchronized ? "synchronized folder" : "groups",
            entitlements: createEntitlements
              ? `created and attached at ${expected}`
              : "updated existing",
            xcodeBeforeAndAfter: "passed",
            build:
              platform === "ios"
                ? "ad hoc signed simulator build carries the edited entitlements; none bundled"
                : "unsigned build; no .entitlements file in the bundle",
            plistValidation: "passed",
            rerun: "no changes",
            publicDryRun: "structured JSON",
            scope:
              "Debug and Release configurations; no provisioning, SDK package resolution, live API, or source integration",
          }),
        );
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    }
