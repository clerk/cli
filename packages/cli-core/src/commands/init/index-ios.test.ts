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
  heuristics,
} from "../../test/lib/init-harness.ts";
import * as apple from "./ios/coordinator.ts";
import { StarterInputRequired } from "./ios/starter-bootstrap.ts";
import { SelectionNeeded } from "./ios/discovery.ts";
import { log } from "../../lib/log.ts";
import { UserAbortError } from "../../lib/errors.ts";
import * as plapi from "../../lib/plapi.ts";
import { ios } from "./frameworks/ios.ts";
import { init } from "./index.ts";

const iosFramework = frameworkMod.lookupFramework("ios")!;
const reactFramework = frameworkMod.lookupFramework("react")!;

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
        expect.stringContaining("`--create-app` in place of `--app <app_id>`"),
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
    [{ starter: true, json: true }, "--json works with --starter only for a new iOS or macOS app"],
    [{ starter: true, dryRun: true }, "--dry-run works on an existing project"],
    [{ createApp: true }, "--create-app is for agent runs"],
    [{ relink: true }, "--relink applies with --app or --create-app"],
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

  describe("an agent's --app naming another application", () => {
    const REPLACED = { appId: "app_A", appName: "Web", scope: "/repo" };

    // Linked to app_A until init links app_B.
    const linkedToA = () =>
      spyOn(config, "resolveProfile")
        .mockResolvedValueOnce({ profile: { appId: "app_A" } } as never)
        .mockResolvedValue({ profile: { appId: "app_B" } } as never);

    function linkedElsewhere(replaced: typeof REPLACED | null = REPLACED) {
      const run = iosProject({ isAgent: true });
      linkedToA();
      const check = spyOn(linkMod, "replacedLink").mockResolvedValue(replaced ?? undefined);
      track(check);
      return { run, check };
    }

    test("stops before relinking the repository", async () => {
      const { run } = linkedElsewhere();

      await expect(init({ app: "app_B" })).rejects.toThrow(
        "/repo is linked to Web (app_A). Linking it to app_B switches every Clerk CLI command in /repo to app_B. Rerun with --relink to switch it, or pass --app app_A to keep the current link.",
      );
      expect(linkMod.link).not.toHaveBeenCalled();
      expect(run).not.toHaveBeenCalled();
    });

    test("with --json, asks to relink as an input-required status", async () => {
      linkedElsewhere();

      await expect(init({ app: "app_B", json: true })).rejects.toThrow("--relink");
      expect(JSON.parse(captured.out)).toEqual({
        status: "input-required",
        appIntegrationComplete: false,
        link: {
          flag: "--relink",
          question: "Switch the Clerk CLI link for /repo from Web (app_A) to app_B?",
          issue: expect.stringContaining("switches every Clerk CLI command in /repo"),
          current: { appId: "app_A", appName: "Web" },
          requested: "app_B",
          scope: "/repo",
        },
      });
    });

    test("--relink switches it", async () => {
      const { run, check } = linkedElsewhere();

      await init({ app: "app_B", relink: true });

      expect(check).not.toHaveBeenCalled();
      expect(linkMod.link).toHaveBeenCalledWith(expect.objectContaining({ app: "app_B" }));
      expect(run).toHaveBeenCalledWith(expect.anything(), "app_B");
    });

    test("a link it wouldn't replace links as before", async () => {
      const { run } = linkedElsewhere(null);

      await init({ app: "app_B" });

      expect(linkMod.link).toHaveBeenCalled();
      expect(run).toHaveBeenCalledWith(expect.anything(), "app_B");
    });

    test("a project init generates in a blank directory is checked before linking", async () => {
      setup({ isAgent: true });
      spyOn(frameworkMod, "lookupFramework").mockReturnValue(reactFramework);
      spyOn(context, "gatherContext").mockResolvedValue({
        ...FAKE_CTX,
        cwd: "/repo/new-react-app",
        framework: reactFramework,
      });
      const check = spyOn(linkMod, "replacedLink").mockResolvedValue(REPLACED);
      track(check);

      await expect(init({ framework: "react", app: "app_B", skills: false })).rejects.toThrow(
        "--relink",
      );
      expect(bootstrapMod.promptAndBootstrap).toHaveBeenCalled();
      expect(check).toHaveBeenCalledWith("/repo/new-react-app", "app_B", { newProject: false });
      expect(linkMod.link).not.toHaveBeenCalled();
    });

    test("a person is asked by clerk link itself, as before", async () => {
      iosProject();
      linkedToA();
      const check = spyOn(linkMod, "replacedLink").mockResolvedValue(REPLACED);
      track(check);

      await init({ app: "app_B" });

      expect(check).not.toHaveBeenCalled();
      expect(linkMod.link).toHaveBeenCalled();
    });
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
          starterProject: expect.objectContaining({ projectName: "MyApp", platform: "ios" }),
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
    ])("rejects %o for a new iOS app before the link checks", async (options, flag) => {
      starter({}, { isAgent: true });
      // Linked elsewhere: the link advice (--app, --create-app) would contradict the flag.
      const check = spyOn(linkMod, "replacedLink").mockResolvedValue({
        appId: "app_A",
        scope: "/repo",
      });
      track(check);

      await expect(init({ starter: true, framework: "ios", ...options })).rejects.toThrow(
        `${flag} applies only to accountless web setup; iOS and macOS apps link a Clerk application instead.`,
      );
      expect(check).not.toHaveBeenCalled();
      expect(bootstrapMod.promptAndBootstrap).not.toHaveBeenCalled();
    });

    test("without Xcode, the starter's own error explains it, not the existing-app advice", async () => {
      starter();
      xcode.mockReturnValue(false);

      await init({ starter: true, framework: "ios", teamId: "COMPANY001" });

      // The real promptAndBootstrap stops here with "needs Xcode on macOS" before writing.
      expect(bootstrapMod.promptAndBootstrap).toHaveBeenCalled();
    });

    test("--json passes on to the starter and reports a missing answer as input-required", async () => {
      starter();
      spyOn(bootstrapMod, "promptAndBootstrap").mockRejectedValue(
        new StarterInputRequired("--name is required for a new app with --json.", "name", {
          suggestion: "MyClerkApp",
        }),
      );

      await expect(init({ starter: true, framework: "ios", json: true })).rejects.toThrow(
        "--name is required",
      );
      expect(bootstrapMod.promptAndBootstrap).toHaveBeenCalledWith(
        expect.any(String),
        iosFramework,
        expect.objectContaining({ json: true }),
      );
      expect(JSON.parse(captured.out)).toEqual({
        status: "input-required",
        appIntegrationComplete: false,
        starter: {
          field: "name",
          flag: "--name",
          question: "What would you like to name your app?",
          issue: "--name is required for a new app with --json.",
          suggestion: "MyClerkApp",
        },
      });
    });

    test("an agent's JSON without an app names the new app and how to finish it", async () => {
      const run = agentStarter();

      await init({ starter: true, framework: "ios", json: true });

      expect(run).not.toHaveBeenCalled();
      expect(JSON.parse(captured.out)).toMatchObject({
        status: "application-required",
        starter: {
          projectName: "MyApp",
          platform: "ios",
          projectDir: "/tmp/test/MyApp",
          continuation: "cd MyApp && clerk init --app <app_id> --json --app-id-prefix COMPANY001",
        },
        next: [
          expect.any(String),
          expect.stringContaining(
            "cd MyApp && clerk init --app <app_id> --json --app-id-prefix COMPANY001",
          ),
          expect.any(String),
        ],
      });
    });

    test("with --app, native setup gets the continuation for that app", async () => {
      const run = starter({}, { isAgent: true });
      track(spyOn(linkMod, "replacedLink").mockResolvedValue(undefined));

      await init({ starter: true, framework: "ios", json: true, app: "app_test" });

      expect(run).toHaveBeenCalledWith(
        expect.objectContaining({
          starterProject: expect.objectContaining({
            continuation: "cd MyApp && clerk init --app app_test --json --app-id-prefix COMPANY001",
          }),
        }),
        "app_test",
      );
    });

    test("a failed link after writing the app reports where it is and how to finish", async () => {
      starter({}, { isAgent: true });
      spyOn(config, "resolveProfile").mockResolvedValue(undefined);
      track(spyOn(linkMod, "replacedLink").mockResolvedValue(undefined));
      spyOn(linkMod, "link").mockRejectedValue(new Error("Network unavailable"));

      await expect(
        init({ starter: true, framework: "ios", json: true, app: "app_new" }),
      ).rejects.toThrow("Network unavailable");
      expect(JSON.parse(captured.out)).toMatchObject({
        status: "setup-interrupted",
        error: "Network unavailable",
        starter: {
          projectName: "MyApp",
          continuation: "cd MyApp && clerk init --app app_new --json --app-id-prefix COMPANY001",
        },
        next: [expect.stringContaining("Don't run --starter again")],
      });
    });

    test("stops before writing a new app that would relink its repository", async () => {
      starter({}, { isAgent: true });
      const check = spyOn(linkMod, "replacedLink").mockResolvedValue({
        appId: "app_A",
        scope: "/repo",
      });
      track(check);

      await expect(init({ starter: true, framework: "ios", app: "app_B" })).rejects.toThrow(
        "/repo is linked to app_A. Linking a new app here to app_B switches every Clerk CLI command in /repo to app_B. Rerun with --relink to switch it, pass --app app_A to share its application, or create the new app outside this repository.",
      );
      expect(check).toHaveBeenCalledWith(expect.any(String), "app_B", { newProject: true });
      expect(bootstrapMod.promptAndBootstrap).not.toHaveBeenCalled();
    });

    test("an agent's continuation keeps --relink", async () => {
      const run = starter({}, { isAgent: true });

      await init({ starter: true, framework: "ios", json: true, app: "app_test", relink: true });

      expect(run).toHaveBeenCalledWith(
        expect.objectContaining({
          starterProject: expect.objectContaining({
            continuation:
              "cd MyApp && clerk init --app app_test --json --relink --app-id-prefix COMPANY001",
          }),
        }),
        "app_test",
      );
    });

    describe("--create-app", () => {
      const CREATED = { application_id: "app_new", name: "MyApp", instances: [] };
      const INSPECTED = { inspection: { input: {} } } as never;

      function creating(overrides: { email?: string | null } = {}) {
        const run = iosProject({ isAgent: true, ...overrides });
        spyOn(frameworkMod, "lookupFramework").mockImplementation((name) =>
          name === "ios" ? iosFramework : null,
        );
        spyOn(bootstrapMod, "promptAndBootstrap").mockResolvedValue(STARTER);
        // Linked to the application init creates, once native setup reads it.
        spyOn(config, "resolveProfile").mockResolvedValue({
          profile: { appId: "app_new" },
        } as never);
        const check = spyOn(linkMod, "replacedLink").mockResolvedValue(undefined);
        const create = spyOn(plapi, "createApplication").mockResolvedValue(CREATED as never);
        track(check);
        track(create);
        track(spyOn(apple, "inspectAppleProject").mockResolvedValue(INSPECTED));
        return { run, check, create };
      }

      test("a cancel while linking stays a cancel, with no interrupted status", async () => {
        const { check } = creating();
        spyOn(linkMod, "link").mockRejectedValue(new UserAbortError());

        await expect(
          init({ starter: true, framework: "ios", createApp: true, json: true }),
        ).rejects.toBeInstanceOf(UserAbortError);
        expect(captured.out).toBe("");
        // A starter's link was checked once, before it was written.
        expect(check).toHaveBeenCalledTimes(1);
      });

      test.each([
        [{ app: "app_test" }, "--create-app and --app cannot be combined"],
        [{ dryRun: true }, "can't be combined with --dry-run"],
      ])("an agent's --create-app rejects %o before anything", async (options, message) => {
        const { create } = creating();

        await expect(init({ createApp: true, ...options })).rejects.toThrow(message);
        expect(create).not.toHaveBeenCalled();
      });

      test("applies only to iOS and macOS apps", async () => {
        setup({ isAgent: true });
        spyOn(frameworkMod, "lookupFramework").mockReturnValue(reactFramework);
        const create = spyOn(plapi, "createApplication").mockResolvedValue(CREATED as never);
        track(create);

        await expect(init({ framework: "react", createApp: true })).rejects.toThrow(
          "--create-app applies only to iOS and macOS apps",
        );
        expect(bootstrapMod.promptAndBootstrap).not.toHaveBeenCalled();
        expect(create).not.toHaveBeenCalled();
      });

      test("asks who's signed in once, though several checks need it", async () => {
        creating();

        await init({ starter: true, framework: "ios", createApp: true });

        expect(heuristics.getAuthenticatedEmail).toHaveBeenCalledTimes(1);
      });

      test("creates the application only after the new app is written, then sets it up", async () => {
        const { run, create } = creating();

        await init({ starter: true, framework: "ios", createApp: true });

        expect(create).toHaveBeenCalledWith("MyApp");
        const written = (bootstrapMod.promptAndBootstrap as ReturnType<typeof spyOn>).mock
          .invocationCallOrder[0]!;
        expect(create.mock.invocationCallOrder[0]!).toBeGreaterThan(written);
        expect(linkMod.link).toHaveBeenCalledWith(
          expect.objectContaining({ app: "app_new", confirmedRelink: true }),
        );
        expect(run).toHaveBeenCalledWith(
          expect.objectContaining({
            starterProject: expect.objectContaining({
              continuation:
                "cd MyApp && clerk init --app app_new --json --app-id-prefix COMPANY001",
            }),
          }),
          "app_new",
        );
      });

      test("a new app's missing answer stops before any application exists", async () => {
        const { create } = creating();
        spyOn(bootstrapMod, "promptAndBootstrap").mockRejectedValue(
          new StarterInputRequired("--name is required for a new app with --json.", "name"),
        );

        await expect(
          init({ starter: true, framework: "ios", createApp: true, json: true }),
        ).rejects.toThrow("--name is required");
        expect(create).not.toHaveBeenCalled();
      });

      test("a repository linked elsewhere stops before the app or application exists", async () => {
        const { check, create } = creating();
        check.mockResolvedValue({ appId: "app_A", appName: "Web", scope: "/repo" });

        await expect(init({ starter: true, framework: "ios", createApp: true })).rejects.toThrow(
          "/repo is linked to Web (app_A). Linking a new app here to a new Clerk application switches every Clerk CLI command in /repo to that application. Rerun with --relink to switch it, pass --app app_A to share its application, or create the new app outside this repository.",
        );
        expect(check).toHaveBeenCalledWith(expect.any(String), undefined, { newProject: true });
        expect(bootstrapMod.promptAndBootstrap).not.toHaveBeenCalled();
        expect(create).not.toHaveBeenCalled();
      });

      test("an agent that isn't signed in stops before the app is written", async () => {
        const { create } = creating({ email: null });

        await expect(init({ starter: true, framework: "ios", createApp: true })).rejects.toThrow(
          "--create-app needs a signed-in Clerk CLI",
        );
        expect(bootstrapMod.promptAndBootstrap).not.toHaveBeenCalled();
        expect(create).not.toHaveBeenCalled();
      });

      test.each([
        {
          name: "before the application is created, continue by creating it",
          fail: "create" as const,
          continuation: "cd MyApp && clerk init --create-app --json --app-id-prefix COMPANY001",
        },
        {
          name: "after it's created, continue with it instead of creating another",
          fail: "link" as const,
          continuation: "cd MyApp && clerk init --app app_new --json --app-id-prefix COMPANY001",
        },
      ])("a failure $name", async ({ fail, continuation }) => {
        const { create } = creating();
        if (fail === "create") create.mockRejectedValue(new Error("Network unavailable"));
        else spyOn(linkMod, "link").mockRejectedValue(new Error("Network unavailable"));

        await expect(
          init({ starter: true, framework: "ios", createApp: true, json: true }),
        ).rejects.toThrow("Network unavailable");
        expect(JSON.parse(captured.out)).toMatchObject({
          status: "setup-interrupted",
          starter: { continuation },
          ...(fail === "link" && { application: { appId: "app_new", created: true } }),
        });
      });

      test("an Xcode failure after writing the new app still says how to finish it", async () => {
        const { create } = creating();
        spyOn(apple, "inspectAppleProject").mockRejectedValue(new Error("xcodebuild timed out"));

        await expect(
          init({ starter: true, framework: "ios", createApp: true, json: true }),
        ).rejects.toThrow("xcodebuild timed out");
        expect(create).not.toHaveBeenCalled();
        expect(JSON.parse(captured.out)).toMatchObject({
          status: "setup-interrupted",
          error: "xcodebuild timed out",
          starter: {
            projectDir: "/tmp/test/MyApp",
            continuation: "cd MyApp && clerk init --create-app --json --app-id-prefix COMPANY001",
          },
        });
      });

      test.each([
        {
          name: "a target to choose",
          fail: () =>
            spyOn(apple, "inspectAppleProject").mockImplementation(async () => {
              log.data(JSON.stringify({ status: "selection-required" }));
              throw new SelectionNeeded([]);
            }),
          status: "selection-required",
        },
      ])("$name after writing prints only its own status", async ({ fail, status }) => {
        const { create } = creating();
        fail();

        await expect(
          init({ starter: true, framework: "ios", createApp: true, json: true }),
        ).rejects.toThrow();
        expect(create).not.toHaveBeenCalled();
        // One JSON document: a second status would make this throw.
        expect(JSON.parse(captured.out).status).toBe(status);
      });

      test("links the application it created without fetching it again", async () => {
        creating();

        await init({ starter: true, framework: "ios", createApp: true });

        expect(linkMod.link).toHaveBeenCalledWith(
          expect.objectContaining({ app: "app_new", application: CREATED }),
        );
      });

      test.each([
        {
          name: "a new app",
          options: { starter: true, framework: "ios" },
          continuation: "cd MyApp && clerk init --app app_new --json --app-id-prefix COMPANY001",
        },
        {
          name: "an existing project",
          options: {},
          continuation: "clerk init --app app_new --json",
        },
      ])(
        "setup for $name hears which application was created",
        async ({ options, continuation }) => {
          const { run } = creating();

          await init({ ...options, createApp: true, json: true });

          expect(run).toHaveBeenCalledWith(
            expect.objectContaining({ createdApplication: { appId: "app_new", continuation } }),
            "app_new",
          );
        },
      );

      test("an existing Xcode project settles its target before creating", async () => {
        const run = iosProject({ isAgent: true });
        spyOn(config, "resolveProfile").mockResolvedValue({
          profile: { appId: "app_new" },
        } as never);
        track(spyOn(linkMod, "replacedLink").mockResolvedValue(undefined));
        const create = spyOn(plapi, "createApplication").mockResolvedValue(CREATED as never);
        track(create);
        const inspect = spyOn(apple, "inspectAppleProject").mockRejectedValue(
          new Error("Choose an app with --xcode-project / --xcode-target"),
        );
        track(inspect);

        await expect(init({ createApp: true, json: true })).rejects.toThrow("Choose an app");
        expect(create).not.toHaveBeenCalled();
        expect(linkMod.link).not.toHaveBeenCalled();
        expect(run).not.toHaveBeenCalled();

        // Settled, setup reuses that inspection instead of asking again.
        const inspection = { input: {} } as never;
        inspect.mockResolvedValue({ inspection });
        await init({ createApp: true, json: true });
        expect(create.mock.invocationCallOrder[0]!).toBeGreaterThan(
          inspect.mock.invocationCallOrder.at(-1)!,
        );
        expect(run).toHaveBeenCalledWith(expect.objectContaining({ inspection }), "app_new");
        expect(inspect).toHaveBeenLastCalledWith(expect.anything(), {}, { newApplication: true });
      });

      test("a link that fails after creating names the application to reuse", async () => {
        iosProject({ isAgent: true });
        track(spyOn(linkMod, "replacedLink").mockResolvedValue(undefined));
        track(spyOn(apple, "inspectAppleProject").mockResolvedValue(INSPECTED));
        track(spyOn(plapi, "createApplication").mockResolvedValue(CREATED as never));
        spyOn(linkMod, "link").mockRejectedValue(new Error("Network unavailable"));

        // The link's own error comes through as it is; the warning names the application to reuse.
        await expect(init({ createApp: true, json: true, appleSdk: "core" })).rejects.toThrow(
          "Network unavailable",
        );
        expect(captured.err).toContain(
          "The application app_new was created, but not linked. Rerun with --app app_new instead of --create-app.",
        );
        expect(JSON.parse(captured.out)).toEqual({
          status: "setup-interrupted",
          appIntegrationComplete: false,
          error: expect.stringContaining("Network unavailable"),
          application: { appId: "app_new", created: true },
          next: [
            "Resolve the error, then run `clerk init --app app_new --json --apple-sdk core`. The application already exists, so don't pass --create-app again.",
          ],
        });
      });

      test("an existing project checks its link before creating", async () => {
        const run = iosProject({ isAgent: true });
        spyOn(config, "resolveProfile").mockResolvedValue({
          profile: { appId: "app_new" },
        } as never);
        const check = spyOn(linkMod, "replacedLink").mockResolvedValue(undefined);
        const create = spyOn(plapi, "createApplication").mockResolvedValue(CREATED as never);
        track(check);
        track(create);
        track(spyOn(apple, "inspectAppleProject").mockResolvedValue(INSPECTED));

        await init({ createApp: true });

        expect(check).toHaveBeenCalledWith("/tmp/test", undefined, { newProject: false });
        expect(create).toHaveBeenCalledWith("test");
        expect(create).toHaveBeenCalled();
        expect(run).toHaveBeenCalledWith(expect.anything(), "app_new");
      });
    });

    describe("an agent's new app with no application chosen", () => {
      function inherits() {
        starter({}, { isAgent: true });
        spyOn(config, "resolveProfile").mockResolvedValue({
          path: "/work",
          profile: { appId: "app_P", appName: "Parent" },
        } as never);
      }

      test("stops before writing instead of using the link it would inherit", async () => {
        inherits();

        await expect(init({ starter: true, framework: "ios", json: true })).rejects.toThrow(
          "is linked to Parent (app_P), so a new app here would use it too. Choose the new app's application: pass --app app_P to share it, --app with another application, or --create-app to create one.",
        );
        expect(JSON.parse(captured.out)).toMatchObject({
          status: "input-required",
          link: {
            flag: "--app",
            question: "Should the new app use Parent (app_P), another application, or a new one?",
            current: { appId: "app_P", appName: "Parent" },
          },
        });
        expect(bootstrapMod.promptAndBootstrap).not.toHaveBeenCalled();
      });

      test("with nothing to inherit, writes the app and asks for one after", async () => {
        const run = agentStarter();

        await init({ starter: true, framework: "ios", json: true });

        expect(bootstrapMod.promptAndBootstrap).toHaveBeenCalled();
        expect(run).not.toHaveBeenCalled();
        expect(JSON.parse(captured.out).status).toBe("application-required");
      });
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
