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

    await expect(init({ dryRun: true })).rejects.toThrow("--dry-run need Xcode");
    await expect(init({ xcodeTarget: "MyApp" })).rejects.toThrow("--xcode-target need Xcode");
    expect(run).not.toHaveBeenCalled();
  });
});
