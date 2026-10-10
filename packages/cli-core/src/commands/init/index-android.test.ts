import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  useInitHarness,
  FAKE_CTX,
  loginMod,
  linkMod,
  pullMod,
  heuristics,
} from "../../test/lib/init-harness.ts";
import * as android from "./android/setup.ts";
import { init } from "./index.ts";

describe("Android init orchestration", () => {
  const harness = useInitHarness();
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "clerk-init-android-"));
    await Bun.write(
      join(root, "app/build.gradle.kts"),
      'plugins { id("org.jetbrains.kotlin.android") version "2.4.20" }\nandroid {\n namespace = "com.example.app"\n defaultConfig {\n applicationId = "com.example.app"\n minSdk = 24\n }\n}',
    );
    await Bun.write(
      join(root, "app/src/main/AndroidManifest.xml"),
      '<manifest xmlns:android="http://schemas.android.com/apk/res/android"><application /></manifest>',
    );
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });
  const context = () => ({
    ...FAKE_CTX,
    cwd: root,
    framework: {
      dep: "android",
      name: "Android (Kotlin)",
      sdk: "com.clerk:clerk-android-api",
      envVar: "CLERK_PUBLISHABLE_KEY",
      envFile: ".env" as const,
      ecosystem: "gradle" as const,
    },
  });

  test("dry run does not authenticate, link, fetch keys or apply setup", async () => {
    harness.setup().gatherContextSpy.mockResolvedValue(context());
    const setup = spyOn(android, "setupAndroid").mockResolvedValue();
    harness.track(setup);
    await init({ dryRun: true, app: "app_1" });
    expect(loginMod.login).not.toHaveBeenCalled();
    expect(linkMod.link).not.toHaveBeenCalled();
    expect(heuristics.isAuthenticated).not.toHaveBeenCalled();
    expect(pullMod.pull).not.toHaveBeenCalled();
    expect(setup).not.toHaveBeenCalled();
    expect(await Bun.file(join(root, "app/src/main/res/values/clerk.xml")).exists()).toBe(false);
  });

  test("authenticated Android init uses native setup instead of generic env pull", async () => {
    harness.setup({ apiKey: true }).gatherContextSpy.mockResolvedValue(context());
    const setup = spyOn(android, "setupAndroid").mockResolvedValue();
    harness.track(setup);
    await init({ app: "app_1", yes: true });
    expect(setup).toHaveBeenCalledWith(
      expect.objectContaining({ packageName: "com.example.app" }),
      { app: "app_1", skipConfirm: true },
    );
    expect(pullMod.pull).not.toHaveBeenCalled();
    expect(heuristics.installSdk).not.toHaveBeenCalled();
  });

  test("an unauthenticated agent without a target previews setup without applying it", async () => {
    harness.setup({ isAgent: true }).gatherContextSpy.mockResolvedValue(context());
    const setup = spyOn(android, "setupAndroid").mockResolvedValue();
    harness.track(setup);
    await init();
    expect(setup).not.toHaveBeenCalled();
    expect(loginMod.login).not.toHaveBeenCalled();
    expect(harness.captured.out + harness.captured.err).toContain("--app <app_id>");
  });

  test("Android-only flags fail on other frameworks before linking", async () => {
    harness.setup().gatherContextSpy.mockResolvedValue(FAKE_CTX);
    await expect(init({ androidPackage: "com.example.app" })).rejects.toThrow("only to Android");
    expect(linkMod.link).not.toHaveBeenCalled();
  });
});
