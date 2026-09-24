import { afterEach, expect, spyOn, test } from "bun:test";
import { join } from "node:path";
import { getMode, setMode } from "../../../mode.ts";
import { getLogLevel, setLogLevel } from "../../../lib/log.ts";
import { useCaptureLog } from "../../../test/lib/stubs.ts";
import * as prompts from "../../../lib/prompts.ts";
import { applyIOSLocalSetup } from "./apply.ts";
import { treeDigest } from "./test-helpers.ts";
import {
  createUnconfiguredFixture,
  canonicalSwiftUIFixture,
  addStarterContentViewToFixture,
  createIsolatedCLIState,
  cleanupApplyCLITestState,
  currentNativeRemoteState,
  resetApplyCLITestRemoteState,
  runCLI,
} from "./apply-cli.test-helpers.ts";

const captured = useCaptureLog();
afterEach(cleanupApplyCLITestState);

test("compact preview preserves the verbose plan, conditional file consent, and read-only preparation", async () => {
  const root = await createUnconfiguredFixture();
  await addStarterContentViewToFixture(root);
  await Bun.write(
    join(root, "MyApp", "MyAppApp.swift"),
    await Bun.file(join(canonicalSwiftUIFixture, "MyApp", "MyAppApp.swift")).text(),
  );
  const before = await treeDigest(root);
  const mode = getMode();
  const level = getLogLevel();
  try {
    setMode("human");
    setLogLevel("info");
    const options = {
      root,
      target: "MyApp",
      agent: false,
      yes: true,
      allowDirty: true,
      prebuiltAuthUI: true,
      signInWithApple: false,
    };
    const compact = await applyIOSLocalSetup(options);
    expect(captured.err).toContain("Local changes:");
    expect(captured.err).toContain("Replace the starter screen");
    expect(captured.err).toContain("only if Apple sign-in is enabled");
    expect(captured.err).not.toContain("Frameworks phase");
    expect(captured.err).not.toContain("remain in memory");
    // Every possible capability file is still presented before approval.
    for (const file of compact.prebuiltAuthAppleEntitlementPlan?.files ?? []) {
      expect(captured.err).toContain(file.path);
    }
    captured.clear();
    setLogLevel("debug");
    const verbose = await applyIOSLocalSetup(options);
    expect(captured.err).toContain("Frameworks phase");
    expect(verbose).toEqual(compact);
    expect(await treeDigest(root)).toEqual(before);
  } finally {
    setMode(mode);
    setLogLevel(level);
  }
});

test("declining the concise local preview still leaves every file unchanged", async () => {
  const root = await createUnconfiguredFixture();
  const before = await treeDigest(root);
  const mode = getMode();
  setMode("human");
  const confirm = spyOn(prompts, "confirm").mockResolvedValue(false);
  try {
    await expect(
      applyIOSLocalSetup({
        root,
        agent: false,
        yes: false,
        allowDirty: true,
        prebuiltAuthUI: false,
        signInWithApple: false,
      }),
    ).rejects.toThrow();
    expect(confirm).toHaveBeenCalledWith({
      message: "Continue with these local changes?",
      default: false,
    });
    expect(await treeDigest(root)).toEqual(before);
  } finally {
    confirm.mockRestore();
    setMode(mode);
  }
});

test("human init completes local and remote setup without nested completion messages", async () => {
  resetApplyCLITestRemoteState();
  const root = await createUnconfiguredFixture();
  const configDir = await createIsolatedCLIState();
  const result = await runCLI(
    root,
    [
      "--mode",
      "human",
      "init",
      "--yes",
      "--app",
      "app_ios_apply",
      "--app-id-prefix",
      "LEGACY1234",
      "--sign-in-with-apple",
    ],
    configDir,
  );
  expect(result.exitCode, result.stderr).toBe(0);
  expect(result.stderr).toContain("Clerk registration changes:");
  expect(result.stderr).toContain("Enable the Native API");
  expect(result.stderr).toContain("Existing web sign-in settings will be preserved");
  expect(result.stderr).toContain("Automatic setup complete");
  expect(result.stderr).not.toContain("No files to scaffold");
  expect(result.stderr).not.toContain("clerk env pull");
  expect(result.stderr).not.toContain("Linking project");
  expect(currentNativeRemoteState().mutations).toEqual({
    nativeSettingsPatchCount: 1,
    iosApplicationPostCount: 1,
    appleConfigPatchCount: 2, // Provider validation dry run, followed by the actual patch.
  });
  expect(await Bun.file(join(root, "MyApp", "MyAppApp.swift")).text()).toContain("Clerk.configure");
});
