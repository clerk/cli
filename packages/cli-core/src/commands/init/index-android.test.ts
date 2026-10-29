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
import { StarterInputRequired } from "./native/starter-input.ts";
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
    await expect(init({ signInWithApple: true })).rejects.toThrow("only to iOS (Swift) projects");
    await expect(init({ appleSdk: "ui" })).rejects.toThrow("only to iOS (Swift) projects");
  });

  test("--prebuilt-auth-ui reaches Android setup", async () => {
    const run = androidProject();
    spyOn(config, "resolveProfile").mockResolvedValue({ profile: { appId: "app_test" } } as never);
    await init({ prebuiltAuthUi: true });
    expect(run).toHaveBeenCalledWith(expect.objectContaining({ prebuiltAuthUi: true }), "app_test");
  });
});

describe("clerk init --starter --framework android", () => {
  const { setup, track, captured } = useInitHarness();
  const STARTER = {
    projectDir: "/tmp/test/MyApp",
    projectName: "MyApp",
    android: { applicationId: "com.example.myapp" },
  };
  let written = false;

  function starter(overrides: { isAgent?: boolean } = {}) {
    setup({ email: "user@example.com", ...overrides });
    spyOn(frameworkMod, "lookupFramework").mockImplementation((name) =>
      name === "android" ? androidFramework : null,
    );
    spyOn(context, "gatherContext").mockResolvedValue({
      ...FAKE_CTX,
      cwd: STARTER.projectDir,
      deps: {},
      framework: androidFramework,
    });
    written = false;
    // Like the real starter: the link checks run once its answers are valid, then it writes.
    spyOn(bootstrapMod, "promptAndBootstrap").mockImplementation(async (_cwd, _fw, options) => {
      await options?.beforeWrite?.(STARTER.projectDir);
      written = true;
      return { ...STARTER };
    });
    spyOn(config, "resolveProfile").mockResolvedValue({ profile: { appId: "app_test" } } as never);
    track(spyOn(config, "getProfile").mockResolvedValue(undefined));
    const run = spyOn(android, "runAndroidInit").mockResolvedValue();
    track(run);
    return run;
  }

  test("writes the app, then sets it up without a confirmation and with the UI default", async () => {
    const run = starter();

    await init({ starter: true, framework: "android", prebuiltAuthUi: true });

    expect(written).toBe(true);
    expect(run).toHaveBeenCalledWith(
      expect.objectContaining({
        root: STARTER.projectDir,
        androidPackage: undefined,
        prebuiltAuthUi: true,
        starterProject: expect.objectContaining({
          projectName: "MyApp",
          platform: "android",
          projectDir: STARTER.projectDir,
          continuation: "cd MyApp && clerk init --app <app_id> --json --prebuilt-auth-ui",
        }),
      }),
      "app_test",
    );
    expect(pullMod.pull).not.toHaveBeenCalled();
  });

  test("passes --android-package and the name to the starter", async () => {
    starter();
    const bootstrap = bootstrapMod.promptAndBootstrap as unknown as ReturnType<typeof spyOn>;

    await init({
      starter: true,
      framework: "android",
      name: "MyApp",
      androidPackage: "org.acme.app",
      androidSdk: "ui",
    });

    expect(bootstrap.mock.calls[0]![2]).toMatchObject({
      nameOverride: "MyApp",
      android: { applicationId: "org.acme.app", flags: ["--android-package", "--android-sdk"] },
    });
  });

  test("an agent with --json and no app creates the app and reports application-required with the continuation", async () => {
    const run = starter({ isAgent: true });
    spyOn(config, "resolveProfile").mockResolvedValue(undefined);

    await init({ starter: true, framework: "android", json: true, name: "MyApp" });

    expect(written).toBe(true);
    expect(run).not.toHaveBeenCalled();
    expect(JSON.parse(captured.out)).toMatchObject({
      status: "application-required",
      starter: expect.objectContaining({ projectName: "MyApp", platform: "android" }),
      next: [
        expect.any(String),
        expect.stringContaining("cd MyApp && clerk init --app <app_id> --json"),
      ],
    });
  });

  test("an answer only the user can give is an input-required status with --json", async () => {
    starter({ isAgent: true });
    (bootstrapMod.promptAndBootstrap as unknown as ReturnType<typeof spyOn>).mockRejectedValue(
      new StarterInputRequired("--name is required for a new app with --json.", "name", {
        suggestion: "MyClerkApp",
      }),
    );

    await expect(init({ starter: true, framework: "android", json: true })).rejects.toThrow(
      "--name is required",
    );
    expect(JSON.parse(captured.out)).toMatchObject({
      status: "input-required",
      input: { field: "name", flag: "--name", suggestion: "MyClerkApp" },
    });
  });

  test("refuses the accountless flags and --android-module before writing", async () => {
    starter();
    await expect(init({ starter: true, framework: "android", accountless: true })).rejects.toThrow(
      "link a Clerk application instead",
    );
    await expect(
      init({ starter: true, framework: "android", androidModule: "app" }),
    ).rejects.toThrow("--starter");
    await expect(
      init({ starter: true, framework: "android", androidSdk: "core", prebuiltAuthUi: true }),
    ).rejects.toThrow("--android-sdk ui");
    expect(written).toBe(false);
  });
});
