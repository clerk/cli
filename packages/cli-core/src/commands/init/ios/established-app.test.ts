import { afterEach, beforeEach, expect, setDefaultTimeout, test } from "bun:test";
import { cp, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { inspectIOSProject } from "./inspect.ts";
import { treeDigest } from "./test-helpers.ts";
import {
  cleanupApplyCLITestState,
  createIsolatedCLIState,
  currentNativeRemoteState,
  resetApplyCLITestRemoteState,
  runCLI,
  temporaryDirectories,
} from "./apply-cli.test-helpers.ts";

setDefaultTimeout(15_000);
beforeEach(resetApplyCLITestRemoteState);
afterEach(cleanupApplyCLITestState);

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "clerk-established-app-"));
  temporaryDirectories.push(root);
  await cp(resolve(import.meta.dir, "../../../../../../test/fixtures/ios-established"), root, {
    recursive: true,
  });
  return root;
}

const initArgs = ["--mode", "agent", "init", "--yes", "--target", "ClerkCorpusIOS"];

test("links the SDK and registers an established app while preserving delegated runtime configuration", async () => {
  const root = await fixture();
  const configDir = await createIsolatedCLIState();
  const inspection = await inspectIOSProject(root);
  const target = inspection.appTargets[0]!;
  expect(target.swift.evidenceComplete).toBe(true);
  expect(target.swift.configureCalls).toHaveLength(1);
  expect(target.swift.configureCalls[0]!.publishableKeyWiring).toBe("custom");
  expect(target.swift.configureCalls[0]!.startupBinding).not.toBe("app-init");
  const sourceBefore = await treeDigest(join(root, "ClerkCorpusIOS"));
  const args = [...initArgs, "--app", "app_ios_apply"];

  const first = await runCLI(root, args, configDir);
  expect(first.exitCode, `${first.stdout}\n${first.stderr}`).toBe(0);
  expect(`${first.stdout}\n${first.stderr}`).toContain(
    "startup execution and runtime key match remain unverified",
  );
  expect(`${first.stdout}\n${first.stderr}`).not.toContain("Clerk is already set up");
  expect(`${first.stdout}\n${first.stderr}`).toContain("does not prove a runtime key match");
  expect(`${first.stdout}\n${first.stderr}`).not.toContain("Configure Clerk directly");
  expect(await treeDigest(join(root, "ClerkCorpusIOS"))).toEqual(sourceBefore);
  const applied = await inspectIOSProject(root);
  expect(applied.appTargets[0]!.packages).toMatchObject({
    clerkKit: "linked",
    clerkKitUI: "absent",
  });
  expect(currentNativeRemoteState()).toMatchObject({
    nativeAPIEnabled: true,
    iosApplications: [{ app_id_prefix: "LEGACY1234", bundle_id: "com.clerk.ClerkCorpusIOS" }],
    mutations: {
      nativeSettingsPatchCount: 1,
      iosApplicationPostCount: 1,
      appleConfigPatchCount: 0,
    },
  });

  const beforeRerun = await treeDigest(root);
  const remoteBefore = currentNativeRemoteState();
  const rerun = await runCLI(root, args, configDir);
  expect(rerun.exitCode, `${rerun.stdout}\n${rerun.stderr}`).toBe(0);
  expect(`${rerun.stdout}\n${rerun.stderr}`).toContain(
    "startup execution and runtime key match remain unverified",
  );
  expect(`${rerun.stdout}\n${rerun.stderr}`).not.toContain("Clerk is already set up");
  expect(await treeDigest(root)).toEqual(beforeRerun);
  expect(currentNativeRemoteState()).toEqual(remoteBefore);
});

test("requires an explicit Clerk app before making progress with a delegated runtime key", async () => {
  const root = await fixture();
  const configDir = await createIsolatedCLIState();
  const before = await treeDigest(root);
  const result = await runCLI(root, initArgs, configDir);
  expect(result.exitCode).toBe(2);
  expect(`${result.stdout}\n${result.stderr}`).toContain("--app");
  expect(await treeDigest(root)).toEqual(before);
  expect(currentNativeRemoteState().mutations).toEqual({
    nativeSettingsPatchCount: 0,
    iosApplicationPostCount: 0,
    appleConfigPatchCount: 0,
  });
});

test.each(["incomplete sources", "conflicting Bundle IDs", "missing prefix", "prebuilt UI"])(
  "preserves operation-specific blockers: %s",
  async (blocker) => {
    const root = await fixture();
    const configDir = await createIsolatedCLIState();
    const path = join(root, "ClerkCorpusIOS.xcodeproj", "project.pbxproj");
    if (blocker === "incomplete sources") {
      await Bun.write(
        path,
        (await Bun.file(path).text()).replace(
          /(isa = PBXSourcesBuildPhase;[\s\S]*?files = \()/,
          "$1 FEFEFEFEFEFEFEFEFEFEFEFE,",
        ),
      );
    } else if (blocker === "conflicting Bundle IDs") {
      await Bun.write(
        path,
        (await Bun.file(path).text()).replace(
          "PRODUCT_BUNDLE_IDENTIFIER = com.clerk.ClerkCorpusIOS;",
          "PRODUCT_BUNDLE_IDENTIFIER = com.clerk.OtherApp;",
        ),
      );
    } else if (blocker === "missing prefix") {
      const entitlements = join(root, "ClerkCorpusIOS", "ClerkCorpusIOS.entitlements");
      await Bun.write(
        entitlements,
        (await Bun.file(entitlements).text()).replace(
          /<key>application-identifier<\/key>\s*<string>[^<]*<\/string>/,
          "",
        ),
      );
    }
    const before = await treeDigest(root);
    const result = await runCLI(
      root,
      [
        ...initArgs,
        "--app",
        "app_ios_apply",
        ...(blocker === "prebuilt UI" ? ["--prebuilt-auth-ui"] : []),
      ],
      configDir,
    );
    expect(result.exitCode, `${result.stdout}\n${result.stderr}`).not.toBe(0);
    expect(await treeDigest(root)).toEqual(before);
    expect(currentNativeRemoteState().mutations).toEqual({
      nativeSettingsPatchCount: 0,
      iosApplicationPostCount: 0,
      appleConfigPatchCount: 0,
    });
  },
);
