import { build, parse } from "@bacons/xcode/json";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createIOSFixture,
  IOS_FIXTURE_IDS as ids,
} from "../../packages/cli-core/src/commands/init/ios/test-helpers.ts";
import { planAllCapabilities } from "../../packages/cli-core/src/commands/init/ios/capabilities.ts";
import { convertFixtureToXCProj } from "../../packages/cli-core/src/commands/init/ios/setup-test-helpers.ts";
import { applyXCProjValue } from "../../packages/cli-core/src/commands/init/ios/xcproj.ts";
import { createFile, replaceProject } from "../../packages/cli-core/src/commands/init/ios/files.ts";
import { inspectSelectedProject } from "../../packages/cli-core/src/commands/init/ios/xcode.ts";

// Real Xcode before AND after capability edits, with no SDK dependencies attached.
for (const format of ["pbxproj", "xcproj"] as const)
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
        const document = join(root, `MyApp.xcodeproj/project.${format}`);
        if (createEntitlements) {
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
            entitlements: createEntitlements ? "created and attached" : "updated existing",
            xcodeBeforeAndAfter: "passed",
            plistValidation: "passed",
            rerun: "no changes",
            publicDryRun: "structured JSON",
            scope:
              "Debug and Release configurations; no signing, app build, SDK package resolution, live API, or source integration",
          }),
        );
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    }
