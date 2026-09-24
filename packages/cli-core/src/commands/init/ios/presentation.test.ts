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
  setApplyCLIResponseDelay,
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
  setApplyCLIResponseDelay(200);
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
  expect(result.stderr).toContain("Checking Clerk settings");
  expect(result.stderr).toContain("Applying your changes");
  expect(result.stderr).not.toContain("Rechecking the selected Xcode target identity");
  expect(result.stderr).not.toContain("Auditing Clerk Native Application settings");
  // Clack hides/shows the cursor when starting/ending an indicator. Within each
  // uninterrupted phase, every animation frame must retain the same label.
  let active: string | undefined;
  let registrationApplyPhases = 0;
  // oxlint-disable-next-line no-control-regex -- Check the terminal cursor's actual escape sequences.
  for (const part of result.stderr.split(/(\u001b\[\?25[hl])/)) {
    if (part === "\u001b[?25l") {
      expect(active).toBeUndefined();
      active = "";
    } else if (part === "\u001b[?25h") {
      if (active?.includes("Applying your changes")) registrationApplyPhases++;
      active = undefined;
    } else if (active !== undefined) {
      active += part;
      expect(part).not.toContain("Clerk registration changes:");
      expect(part).not.toContain("Existing web sign-in settings will be preserved");
      expect(part).not.toContain("registered with Clerk");
      expect(part).not.toContain("application registration verified");
      expect(part).not.toContain("Native Sign in with Apple enabled in Clerk");
    }
  }
  expect(active).toBeUndefined();
  // Registration and its API enablement/rechecks share one indicator; Apple
  // connection setup shares another after the registration result is printed.
  expect(registrationApplyPhases).toBe(2);
  expect(currentNativeRemoteState().mutations).toEqual({
    nativeSettingsPatchCount: 1,
    iosApplicationPostCount: 1,
    appleConfigPatchCount: 2, // Provider validation dry run, followed by the actual patch.
  });
  expect(await Bun.file(join(root, "MyApp", "MyAppApp.swift")).text()).toContain("Clerk.configure");
});
