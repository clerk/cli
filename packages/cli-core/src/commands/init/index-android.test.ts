import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import {
  useInitHarness,
  FAKE_CTX,
  context,
  config,
  loginMod,
  pullMod,
  linkMod,
  frameworkMod,
  heuristics,
  skillsMod,
  bootstrapMod,
  scaffoldMod,
} from "../../test/lib/init-harness.ts";
import { android as androidScaffold } from "./frameworks/android.ts";
import * as android from "./android/coordinator.ts";
import { UnsupportedLayout } from "./android/types.ts";
import * as apple from "./ios/coordinator.ts";
import { init } from "./index.ts";

const androidFramework = frameworkMod.lookupFramework("android")!;
const reactFramework = frameworkMod.lookupFramework("react")!;

describe("clerk init for Android projects", () => {
  const { setup, track, captured } = useInitHarness();
  let xcode: ReturnType<typeof spyOn>;
  beforeEach(() => {
    xcode = spyOn(apple, "canSetUpXcode").mockReturnValue(false);
  });
  afterEach(() => xcode.mockRestore());

  function androidProject(overrides: { isAgent?: boolean; email?: string | null } = {}) {
    setup({ email: "user@example.com", ...overrides });
    spyOn(context, "gatherContext").mockResolvedValue({
      ...FAKE_CTX,
      deps: {},
      framework: androidFramework,
    });
    const run = spyOn(android, "runAndroidInit").mockResolvedValue();
    track(run);
    return run;
  }

  test("sets up the linked app instead of pulling keys into an env file", async () => {
    const run = androidProject();
    spyOn(config, "resolveProfile").mockResolvedValue({ profile: { appId: "app_test" } } as never);

    await init({ androidSdk: "ui" });

    expect(run).toHaveBeenCalledWith(
      expect.objectContaining({ root: "/tmp/test", agent: false, androidSdk: "ui" }),
      "app_test",
    );
    expect(pullMod.pull).not.toHaveBeenCalled();
    expect(heuristics.installSdk).not.toHaveBeenCalled();
    expect(skillsMod.installSkills).not.toHaveBeenCalled();
  });

  test("a layout native setup refuses falls back to the env file and the manual steps", async () => {
    setup({ email: "user@example.com" });
    spyOn(context, "gatherContext").mockResolvedValue({
      ...FAKE_CTX,
      deps: {},
      framework: androidFramework,
    });
    spyOn(config, "resolveProfile").mockResolvedValue({ profile: { appId: "app_test" } } as never);
    const run = spyOn(android, "runAndroidInit").mockRejectedValue(
      new UnsupportedLayout("the build declares product flavors."),
    );
    track(run);
    const scaffold = spyOn(scaffoldMod, "scaffold").mockImplementation(async (ctx) =>
      androidScaffold.scaffold(ctx),
    );
    track(scaffold);

    await init({ json: true });

    expect(run).toHaveBeenCalled();
    expect(pullMod.pull).toHaveBeenCalledWith({ file: ".env", cwd: "/tmp/test" });
    expect(captured.err).toContain("the build declares product flavors.");
    expect(captured.err).toContain("Pulling the publishable key into the env file");
    expect(scaffold.mock.calls[0]![0].nativeFallback).toBe("the build declares product flavors.");
    expect(JSON.parse(captured.out)).toMatchObject({
      status: "manual-setup-required",
      appIntegrationComplete: false,
      reason: "the build declares product flavors.",
      envFile: ".env",
      next: expect.arrayContaining([expect.stringContaining("clerk env pull")]),
    });
  });

  test("other native setup failures are not swallowed", async () => {
    setup({ email: "user@example.com" });
    spyOn(context, "gatherContext").mockResolvedValue({
      ...FAKE_CTX,
      deps: {},
      framework: androidFramework,
    });
    spyOn(config, "resolveProfile").mockResolvedValue({ profile: { appId: "app_test" } } as never);
    track(spyOn(android, "runAndroidInit").mockRejectedValue(new Error("Clerk is down")));
    await expect(init({})).rejects.toThrow("Clerk is down");
    expect(pullMod.pull).not.toHaveBeenCalled();
  });

  test("links through the usual flow before native setup", async () => {
    const run = androidProject();
    spyOn(config, "resolveProfile")
      .mockResolvedValueOnce(undefined)
      .mockResolvedValue({ profile: { appId: "app_picked" } } as never);

    await init({});

    expect(linkMod.link).toHaveBeenCalledWith(
      expect.objectContaining({ skipIfLinked: true, showNextSteps: false }),
    );
    expect(run).toHaveBeenCalledWith(expect.anything(), "app_picked");
  });

  test("an agent with no app or link gets manual guidance naming the continuation", async () => {
    const run = androidProject({ isAgent: true });

    await init({ androidModule: "app" });

    expect(run).not.toHaveBeenCalled();
    expect(loginMod.login).not.toHaveBeenCalled();
    expect(captured.err).toContain("clerk init --app <app_id> --json --android-module app");
    expect(captured.err).not.toContain("clerk env pull");
  });

  test("an agent asking for JSON with no app gets an application-required status", async () => {
    const run = androidProject({ isAgent: true });

    await init({ json: true, androidFingerprint: ["ab".repeat(32)], androidSdk: "core" });

    expect(run).not.toHaveBeenCalled();
    const status = JSON.parse(captured.out);
    expect(status).toMatchObject({ status: "application-required", appIntegrationComplete: false });
    expect(status.next[1]).toContain("configure the Android project");
    expect(status.next[1]).toContain(
      `\`clerk init --app <app_id> --json --android-fingerprint ${"ab".repeat(32)} --android-sdk core\``,
    );
  });

  test("a dry run inspects without signing in", async () => {
    const run = androidProject({ email: null });

    await init({ dryRun: true, json: true });

    expect(run).toHaveBeenCalledWith(expect.objectContaining({ dryRun: true }), undefined);
    expect(loginMod.login).not.toHaveBeenCalled();
    expect(linkMod.link).not.toHaveBeenCalled();
    expect(heuristics.isAuthenticated).not.toHaveBeenCalled();
  });

  test("--android-* flags select Android setup without a root manifest", async () => {
    setup({ email: "user@example.com" });
    spyOn(frameworkMod, "lookupFramework").mockImplementation((name) =>
      name === "android" ? androidFramework : null,
    );
    const gather = spyOn(context, "gatherContext").mockResolvedValue({
      ...FAKE_CTX,
      deps: {},
      framework: androidFramework,
    });
    spyOn(config, "resolveProfile").mockResolvedValue({ profile: { appId: "app_test" } } as never);
    const run = spyOn(android, "runAndroidInit").mockResolvedValue();
    track(run);

    await init({ androidModule: "mobile" });

    expect(gather).toHaveBeenCalledWith(process.cwd(), androidFramework, undefined);
    expect(run).toHaveBeenCalledWith(
      expect.objectContaining({ androidModule: "mobile" }),
      "app_test",
    );
    expect(bootstrapMod.promptAndBootstrap).not.toHaveBeenCalled();
  });

  test("--framework android without package.json does not trigger bootstrap", async () => {
    setup({ email: "user@example.com" });
    spyOn(frameworkMod, "lookupFramework").mockReturnValue(androidFramework);
    spyOn(context, "gatherContext").mockResolvedValue({
      ...FAKE_CTX,
      deps: {},
      framework: androidFramework,
    });
    spyOn(context, "hasPackageJson").mockResolvedValue(false);
    spyOn(config, "resolveProfile").mockResolvedValue({ profile: { appId: "app_test" } } as never);
    const run = spyOn(android, "runAndroidInit").mockResolvedValue();
    track(run);

    await init({ yes: true, framework: "android" });

    expect(bootstrapMod.promptAndBootstrap).not.toHaveBeenCalled();
    expect(run).toHaveBeenCalled();
  });

  test("Android flags are usage errors on other frameworks and with --starter", async () => {
    setup({ email: "user@example.com" });
    spyOn(context, "gatherContext").mockResolvedValue({ ...FAKE_CTX, framework: reactFramework });
    await expect(init({ androidPackage: "com.example.app" })).rejects.toThrow(
      "--android-package applies only to Android (Kotlin) projects.",
    );
    await expect(init({ starter: true, androidModule: "app" })).rejects.toThrow("--starter");
    await expect(init({ androidFingerprint: ["nope"] })).rejects.toThrow("SHA-256");
    expect(linkMod.link).not.toHaveBeenCalled();
  });

  test("Apple flags are usage errors on an Android project", async () => {
    androidProject();
    await expect(init({ prebuiltAuthUi: true })).rejects.toThrow("only to iOS (Swift) projects");
    await expect(init({ appleSdk: "ui" })).rejects.toThrow("only to iOS (Swift) projects");
  });
});

describe("clerk init --sign-in-with-google flags", () => {
  const { setup, track, captured } = useInitHarness();
  let xcode: ReturnType<typeof spyOn>;
  beforeEach(() => {
    xcode = spyOn(apple, "canSetUpXcode").mockReturnValue(false);
  });
  afterEach(() => xcode.mockRestore());

  test("the Google flags reach native setup and the agent continuation", async () => {
    setup({ email: "user@example.com", isAgent: true });
    spyOn(context, "gatherContext").mockResolvedValue({
      ...FAKE_CTX,
      deps: {},
      framework: androidFramework,
    });
    const run = spyOn(android, "runAndroidInit").mockResolvedValue();
    track(run);
    await init({
      json: true,
      signInWithGoogle: true,
      googleClientId: "1-a.apps.googleusercontent.com",
      googleClientSecretFile: "-",
    });
    expect(JSON.parse(captured.out).next[1]).toContain(
      "--sign-in-with-google --google-client-id 1-a.apps.googleusercontent.com --google-client-secret-file -",
    );
  });

  test("the credential flags need --sign-in-with-google, and a dry run takes no secret", async () => {
    setup({ email: "user@example.com" });
    spyOn(context, "gatherContext").mockResolvedValue({
      ...FAKE_CTX,
      deps: {},
      framework: androidFramework,
    });
    await expect(init({ googleClientId: "1-a.apps.googleusercontent.com" })).rejects.toThrow(
      "apply with --sign-in-with-google",
    );
    await expect(
      init({ dryRun: true, signInWithGoogle: true, googleClientSecretFile: "x" }),
    ).rejects.toThrow("--dry-run never configures");
  });
});
