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
  bootstrapMod,
  scaffoldMod,
} from "../../test/lib/init-harness.ts";
import * as apple from "./ios/coordinator.ts";
import { ios } from "./frameworks/ios.ts";
import { init } from "./index.ts";

const iosFramework = frameworkMod.lookupFramework("ios")!;

describe("clerk init for native Apple projects", () => {
  const { setup, track, captured } = useInitHarness();
  let xcode: ReturnType<typeof spyOn>;
  beforeEach(() => {
    xcode = spyOn(apple, "canSetUpXcode").mockReturnValue(true);
  });
  afterEach(() => xcode.mockRestore());

  function iosProject(overrides: { isAgent?: boolean; email?: string | null } = {}) {
    setup({ email: "user@example.com", ...overrides });
    spyOn(context, "gatherContext").mockResolvedValue({
      ...FAKE_CTX,
      deps: {},
      framework: iosFramework,
    });
    const run = spyOn(apple, "runAppleInit").mockResolvedValue();
    track(run);
    return run;
  }

  test("sets up the linked app instead of pulling keys into an env file", async () => {
    const run = iosProject();
    spyOn(config, "resolveProfile").mockResolvedValue({ profile: { appId: "app_test" } } as never);

    await init({});

    expect(run).toHaveBeenCalledWith(
      expect.objectContaining({ root: "/tmp/test", agent: false }),
      "app_test",
    );
    expect(pullMod.pull).not.toHaveBeenCalled();
  });

  test("links through the usual flow before native setup", async () => {
    const run = iosProject();
    spyOn(config, "resolveProfile")
      .mockResolvedValueOnce(undefined)
      .mockResolvedValue({ profile: { appId: "app_picked" } } as never);

    await init({});

    expect(linkMod.link).toHaveBeenCalledWith(
      expect.objectContaining({ skipIfLinked: true, showNextSteps: false }),
    );
    expect(run).toHaveBeenCalledWith(expect.anything(), "app_picked");
  });

  test("an agent with no app or link gets the usual manual guidance, not native setup", async () => {
    const run = iosProject({ isAgent: true });

    await init({});

    expect(run).not.toHaveBeenCalled();
    expect(loginMod.login).not.toHaveBeenCalled();
    expect(captured.err).toContain("clerk init --app <app_id>");
    expect(captured.err).not.toContain("clerk env pull");
  });

  test("an agent asking for JSON with no app gets an application-required status", async () => {
    const run = iosProject({ isAgent: true });

    await init({ json: true });

    expect(run).not.toHaveBeenCalled();
    expect(JSON.parse(captured.out)).toMatchObject({
      status: "application-required",
      next: [
        expect.stringContaining("clerk apps list --json"),
        expect.stringContaining("clerk init --app"),
      ],
    });
  });

  test("an agent's JSON continuation keeps its Xcode selection and setup options", async () => {
    iosProject({ isAgent: true });

    await init({ json: true, xcodeProject: "My App.xcodeproj", appleSdk: "core" });

    expect(JSON.parse(captured.out).next[1]).toContain(
      "`clerk init --app <app_id> --json --xcode-project 'My App.xcodeproj' --apple-sdk core`",
    );
  });

  test("a dry run inspects without signing in", async () => {
    const run = iosProject({ email: null });

    await init({ dryRun: true, json: true });

    expect(run).toHaveBeenCalledWith(expect.objectContaining({ dryRun: true }), undefined);
    expect(loginMod.login).not.toHaveBeenCalled();
    expect(linkMod.link).not.toHaveBeenCalled();
  });

  test("--xcode-project selects native Apple setup without a root marker", async () => {
    setup();
    spyOn(frameworkMod, "lookupFramework").mockImplementation((name) =>
      name === "ios" ? iosFramework : null,
    );
    spyOn(context, "gatherContext").mockImplementation(async (_cwd, framework) =>
      framework ? { ...FAKE_CTX, framework } : null,
    );
    const run = spyOn(apple, "runAppleInit").mockResolvedValue();
    track(run);

    await init({ xcodeProject: "ios/MyApp.xcodeproj", dryRun: true });

    expect(run).toHaveBeenCalledWith(
      expect.objectContaining({ xcodeProject: "ios/MyApp.xcodeproj" }),
      undefined,
    );
  });

  test.each([
    [{ dryRun: true }, "--dry-run isn't supported for React yet"],
    [{ json: true }, "--json isn't supported for React yet"],
    [{ appleSdk: "ui" as const }, "--apple-sdk applies only to iOS (Swift) projects"],
  ])("rejects %o for a web framework", async (options, message) => {
    setup();
    spyOn(context, "gatherContext").mockResolvedValue(FAKE_CTX);

    await expect(init(options)).rejects.toThrow(message);
  });

  test.each([
    [{ json: true }, "--json needs an existing project"],
    [{ xcodeTarget: "MyApp" }, "--xcode-target needs an existing project"],
    [{ dryRun: true, json: true }, "--dry-run, --json need an existing project"],
  ])("%o never bootstraps a new project", async (options, message) => {
    setup();
    spyOn(context, "gatherContext").mockResolvedValue(null);

    await expect(init(options)).rejects.toThrow(message);
    expect(bootstrapMod.promptAndBootstrap).not.toHaveBeenCalled();
  });

  test("an unsupported flag stops before any project is created", async () => {
    setup();
    spyOn(frameworkMod, "lookupFramework").mockReturnValue(FAKE_CTX.framework);

    await expect(init({ framework: "react", xcodeTarget: "MyApp" })).rejects.toThrow(
      "--xcode-target applies only to iOS (Swift) projects",
    );
    expect(bootstrapMod.promptAndBootstrap).not.toHaveBeenCalled();
    expect(context.gatherContext).not.toHaveBeenCalled();
  });

  test.each([
    [{ starter: true, json: true }, "not with --starter"],
    [{ dryRun: true, app: "app_test" }, "--dry-run never signs in"],
    [{ appIdPrefix: "short" }, "--app-id-prefix must be"],
    [{ appleSdk: "core" as const, prebuiltAuthUi: true }, "--prebuilt-auth-ui needs ClerkKitUI"],
  ])("rejects %o before doing anything", async (options, message) => {
    iosProject();
    await expect(init(options)).rejects.toThrow(message);
  });

  test("without Xcode, links and pulls keys like before", async () => {
    xcode.mockReturnValue(false);
    const run = iosProject();
    spyOn(config, "resolveProfile").mockResolvedValue({ profile: { appId: "app_test" } } as never);
    spyOn(scaffoldMod, "scaffold").mockResolvedValue({
      actions: [],
      postInstructions: ["Add the Clerk iOS SDK via Swift Package Manager"],
    });

    await init({});

    expect(run).not.toHaveBeenCalled();
    expect(pullMod.pull).toHaveBeenCalled();
  });

  test("without Xcode, Apple-only flags fail before anything else", async () => {
    xcode.mockReturnValue(false);
    const run = iosProject();

    await expect(init({ dryRun: true })).rejects.toThrow("--dry-run needs Xcode");
    await expect(init({ xcodeTarget: "MyApp" })).rejects.toThrow("--xcode-target needs Xcode");
    await expect(init({ dryRun: true, json: true })).rejects.toThrow(
      "--dry-run, --json need Xcode",
    );
    expect(run).not.toHaveBeenCalled();
  });

  describe("--starter", () => {
    const STARTER = {
      projectDir: "/tmp/test/MyApp",
      projectName: "MyApp",
      apple: {
        platform: "ios" as "ios" | "macos",
        bundleIdentifier: "com.example.MyApp",
        teamId: "COMPANY001",
        personalTeam: false,
      },
    };

    function starter(
      apple: Partial<typeof STARTER.apple> = {},
      overrides: { isAgent?: boolean } = {},
    ) {
      const run = iosProject(overrides);
      spyOn(frameworkMod, "lookupFramework").mockImplementation((name) =>
        name === "ios" ? iosFramework : null,
      );
      spyOn(bootstrapMod, "promptAndBootstrap").mockResolvedValue({
        ...STARTER,
        apple: { ...STARTER.apple, ...apple },
      });
      spyOn(config, "resolveProfile").mockResolvedValue({
        profile: { appId: "app_test" },
      } as never);
      return run;
    }

    test("sets up the new app with its team, reading the Bundle ID back from Xcode", async () => {
      const run = starter();

      await init({ starter: true, framework: "ios" });

      expect(run).toHaveBeenCalledWith(
        expect.objectContaining({
          bundleId: undefined,
          appIdPrefix: "COMPANY001",
          starterProject: { projectName: "MyApp", platform: "ios" },
        }),
        "app_test",
      );
    });

    test("keeps an explicit --app-id-prefix over the team", async () => {
      const run = starter();

      await init({ starter: true, framework: "ios", appIdPrefix: "LEGACY0001" });

      expect(run).toHaveBeenCalledWith(
        expect.objectContaining({ appIdPrefix: "LEGACY0001" }),
        "app_test",
      );
    });

    test("passes Apple answers and the macOS platform to the starter", async () => {
      starter({ platform: "macos" });

      await init({
        starter: true,
        framework: "macos",
        bundleId: "com.example.MyApp",
        teamId: "COMPANY001",
      });

      expect(bootstrapMod.promptAndBootstrap).toHaveBeenCalledWith(
        expect.any(String),
        iosFramework,
        expect.objectContaining({
          apple: expect.objectContaining({
            platform: "macos",
            bundleId: "com.example.MyApp",
            teamId: "COMPANY001",
            flags: ["--bundle-id", "--team-id"],
          }),
        }),
      );
    });

    test("an agent without an app is told to finish setup inside the new app", async () => {
      const run = starter({}, { isAgent: true });
      spyOn(config, "resolveProfile").mockResolvedValue(undefined);
      // A new starter has no Clerk package yet.
      spyOn(context, "gatherContext").mockResolvedValue({
        ...FAKE_CTX,
        cwd: STARTER.projectDir,
        deps: {},
        existingClerk: false,
        framework: iosFramework,
      });
      spyOn(scaffoldMod, "scaffold").mockResolvedValue({
        actions: [],
        postInstructions: ["Then run `clerk init --app <app_id> --json`."],
      } as never);

      await init({ starter: true, framework: "ios" });

      expect(run).not.toHaveBeenCalled();
      expect(captured.err).toContain("cd MyApp");
      expect(captured.err).toContain("clerk init --app <app_id> --json");
    });

    function agentStarter(apple: Partial<typeof STARTER.apple> = {}) {
      const run = starter(apple, { isAgent: true });
      spyOn(config, "resolveProfile").mockResolvedValue(undefined);
      spyOn(context, "gatherContext").mockResolvedValue({
        ...FAKE_CTX,
        cwd: STARTER.projectDir,
        deps: {},
        existingClerk: false,
        framework: iosFramework,
      });
      // The real iOS plan, so its continuation line is the one checked.
      spyOn(scaffoldMod, "scaffold").mockImplementation(async (ctx) => ios.scaffold(ctx));
      return run;
    }

    test.each([
      {
        name: "explicit options",
        options: { appleSdk: "core" as const, appIdPrefix: "LEGACY0001", signInWithApple: true },
        command:
          "cd MyApp && clerk init --app <app_id> --json --apple-sdk core --app-id-prefix LEGACY0001 --sign-in-with-apple",
      },
      {
        name: "the starter's team as the App ID Prefix",
        options: { prebuiltAuthUi: true },
        command:
          "cd MyApp && clerk init --app <app_id> --json --app-id-prefix COMPANY001 --prebuilt-auth-ui",
      },
      {
        name: "no Bundle ID or team, which the new project already holds",
        options: { bundleId: "com.example.MyApp", teamId: "COMPANY001" },
        command: "cd MyApp && clerk init --app <app_id> --json --app-id-prefix COMPANY001",
      },
    ])("an agent's continuation carries $name", async ({ options, command }) => {
      const run = agentStarter();

      await init({ starter: true, framework: "ios", ...options });

      expect(run).not.toHaveBeenCalled();
      // Every place that names the next command names the same one, starting in the new app.
      const plain = Bun.stripANSI(captured.err);
      expect(plain).toContain(`Then run \`${command}\``);
      expect(plain.match(/(?:cd \S+ && )?clerk init --app <app_id>[^\n`]*/g)).toEqual([
        command,
        command,
        command,
      ]);
    });

    test.each([
      [{ xcodeProject: "Other.xcodeproj" }, "--xcode-project selects an existing Xcode project"],
      [{ xcodeTarget: "Foo" }, "--xcode-target selects an existing Xcode project"],
      [
        { xcodeTarget: "Foo", xcodeConfiguration: "Debug" },
        "--xcode-target, --xcode-configuration select an existing Xcode project",
      ],
    ])("rejects %o with --starter before creating anything", async (options, message) => {
      setup();

      await expect(init({ starter: true, framework: "ios", ...options })).rejects.toThrow(message);
      expect(bootstrapMod.promptAndBootstrap).not.toHaveBeenCalled();
    });

    test.each([
      [{ accountless: true }, "--accountless"],
      [{ template: "native" as const }, "--template"],
      [{ fresh: true }, "--fresh"],
    ])("hands %o to the starter so it's rejected before writing", async (options, flag) => {
      starter();

      await init({ starter: true, framework: "ios", ...options }).catch(() => undefined);

      expect(bootstrapMod.promptAndBootstrap).toHaveBeenCalledWith(
        expect.any(String),
        iosFramework,
        expect.objectContaining({ accountlessFlags: [flag] }),
      );
    });

    test("without Xcode, the starter's own error explains it, not the existing-app advice", async () => {
      starter();
      xcode.mockReturnValue(false);

      await init({ starter: true, framework: "ios", teamId: "COMPANY001" });

      // The real promptAndBootstrap stops here with "needs Xcode on macOS" before writing.
      expect(bootstrapMod.promptAndBootstrap).toHaveBeenCalled();
    });

    test("--team-id needs --starter", async () => {
      setup();

      await expect(init({ teamId: "COMPANY001" })).rejects.toThrow(
        "--team-id applies to a new app with --starter",
      );
      expect(bootstrapMod.promptAndBootstrap).not.toHaveBeenCalled();
    });
  });
});
