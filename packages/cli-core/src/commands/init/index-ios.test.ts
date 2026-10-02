import { describe, expect, spyOn, test } from "bun:test";
import {
  useInitHarness,
  FAKE_CTX,
  context,
  config,
  loginMod,
  pullMod,
  linkMod,
  plapiMod,
  frameworkMod,
} from "../../test/lib/init-harness.ts";
import * as apple from "./ios/coordinator.ts";
import { ERROR_CODE } from "../../lib/errors.ts";
import { init } from "./index.ts";

const iosFramework = frameworkMod.lookupFramework("ios")!;

describe("public Apple init routing", () => {
  const { setup, track } = useInitHarness();
  function native(agent = false, email: string | null = "user@example.com") {
    setup({ isAgent: agent, email });
    spyOn(context, "gatherContext").mockResolvedValue({
      ...FAKE_CTX,
      deps: {},
      framework: {
        dep: "ios",
        name: "iOS (Swift)",
        sdk: "ClerkKit",
        envVar: "CLERK_PUBLISHABLE_KEY",
        envFile: ".env",
        ecosystem: "swift",
      },
    });
  }
  test("plain init routes to the new engine and reuses the linked application", async () => {
    native();
    spyOn(config, "resolveProfile").mockResolvedValue({ profile: { appId: "app_test" } } as never);
    const run = spyOn(apple, "runAppleInit").mockImplementation(async (options, authenticate) => {
      expect(options).toMatchObject({ root: "/tmp/test", agent: false });
      expect(await authenticate()).toBe("app_test");
    });
    track(run);
    await init({});
    expect(run).toHaveBeenCalledTimes(1);
    expect(pullMod.pull).not.toHaveBeenCalled();
    expect(loginMod.login).not.toHaveBeenCalled();
  });
  test.each([
    { project: "native/MyApp.xcodeproj", dryRun: true },
    { project: "native/MyApp.xcworkspace", dryRun: false },
  ])("explicit $project routes to Apple setup (dryRun=$dryRun)", async ({ project, dryRun }) => {
    setup();
    spyOn(frameworkMod, "lookupFramework").mockImplementation((name) =>
      name === "ios" ? iosFramework : null,
    );
    spyOn(context, "gatherContext").mockImplementation(async (_cwd, framework) =>
      framework?.dep === "ios" ? { ...FAKE_CTX, framework } : dryRun ? null : FAKE_CTX,
    );
    const run = spyOn(apple, "runAppleInit").mockResolvedValue();
    track(run);

    await init({ project, dryRun, json: true, yes: true });

    expect(run).toHaveBeenCalledWith(
      expect.objectContaining({ project, dryRun, root: "/tmp/test" }),
      expect.any(Function),
    );
    expect(loginMod.login).not.toHaveBeenCalled();
    expect(pullMod.pull).not.toHaveBeenCalled();
  });
  test("an explicit web framework conflicts with an Apple project selection", async () => {
    setup();
    spyOn(frameworkMod, "lookupFramework").mockReturnValue(FAKE_CTX.framework);

    await expect(init({ project: "native/MyApp.xcodeproj", framework: "react" })).rejects.toThrow(
      "apply only to native Apple projects",
    );
    expect(context.gatherContext).not.toHaveBeenCalled();
  });
  test("an agent without an application receives actionable guidance instead of an interactive picker", async () => {
    native(true);
    const run = spyOn(apple, "runAppleInit").mockImplementation(async (_options, authenticate) => {
      await authenticate();
    });
    track(run);
    await expect(init({ yes: true })).rejects.toThrow("Run `clerk apps list --json`");
    expect(loginMod.login).not.toHaveBeenCalled();
  });
  test("an unlinked agent can authenticate before being asked to select an application", async () => {
    native(true, null);
    const run = spyOn(apple, "runAppleInit").mockImplementation(async (_options, authenticate) => {
      await authenticate();
    });
    track(run);
    await expect(init({ yes: true })).rejects.toThrow(
      "You're signed in. Setup needs a Clerk application.",
    );
    expect(loginMod.login).toHaveBeenCalledWith({ showNextSteps: false, embedded: true });
    expect(linkMod.link).not.toHaveBeenCalled();
    expect(pullMod.pull).not.toHaveBeenCalled();
  });
  test("core SDK plus prebuilt UI fails before setup", async () => {
    native();
    const run = spyOn(apple, "runAppleInit").mockResolvedValue();
    track(run);
    await expect(init({ sdk: "core", prebuiltAuthUI: true })).rejects.toThrow(
      "requires ClerkKitUI",
    );
    expect(run).not.toHaveBeenCalled();
  });

  for (const json of [false, true]) {
    test(`an Apple agent reports a post-link mismatch as failure (json=${json})`, async () => {
      native(!json);
      spyOn(config, "resolveProfile").mockResolvedValue({
        profile: { appId: "app_existing" },
      } as never);
      const run = spyOn(apple, "runAppleInit").mockImplementation(
        async (_options, authenticate) => {
          await authenticate();
        },
      );
      track(run);
      await expect(init({ yes: true, json, app: "app_requested" })).rejects.toMatchObject({
        code: ERROR_CODE.NOT_LINKED,
      });
      expect(pullMod.pull).not.toHaveBeenCalled();
    });

    test(`an unauthenticated Apple agent can log in and continue (json=${json})`, async () => {
      native(!json, null);
      spyOn(config, "resolveProfile")
        .mockResolvedValueOnce(undefined)
        .mockResolvedValue({ profile: { appId: "app_test" } } as never);
      const run = spyOn(apple, "runAppleInit").mockImplementation(
        async (_options, authenticate) => {
          expect(await authenticate()).toBe("app_test");
        },
      );
      track(run);

      await init({ yes: true, json, app: "app_test" });

      expect(loginMod.login).toHaveBeenCalledWith({ showNextSteps: false, embedded: true });
      expect(linkMod.link).toHaveBeenCalledWith(
        expect.objectContaining({
          app: "app_test",
          skipAutolink: true,
          embedded: true,
        }),
      );
      expect(plapiMod.listApplications).not.toHaveBeenCalled();
      expect(pullMod.pull).not.toHaveBeenCalled();
    });
  }

  test("failed browser login stops Apple setup before linking", async () => {
    native(true, null);
    spyOn(loginMod, "login").mockRejectedValue(new Error("Login cancelled"));
    const run = spyOn(apple, "runAppleInit").mockImplementation(async (_options, authenticate) => {
      await authenticate();
    });
    track(run);

    await expect(init({ yes: true, app: "app_test" })).rejects.toThrow("Login cancelled");
    expect(linkMod.link).not.toHaveBeenCalled();
    expect(pullMod.pull).not.toHaveBeenCalled();
  });
});
