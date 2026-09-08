import { test, expect, describe, spyOn } from "bun:test";

// Pure spyOn approach — Bun's mock.module globally replaces modules for the
// entire test run, which pollutes other test files that import the same
// modules. spyOn restores cleanly. Shared setup lives in the harness.
import {
  useInitHarness,
  FAKE_CTX,
  FAKE_BOOTSTRAP,
  loginMod,
  linkMod,
  pullMod,
  config,
  frameworkMod,
  context,
  scaffoldMod,
  previewMod,
  heuristics,
  skillsMod,
  bootstrapMod,
  nextStepsMod,
  mockExistingProject,
  mockMiddlewareScaffold,
} from "../../test/lib/init-harness.ts";
import * as telemetryMod from "../../lib/telemetry.ts";
import { init } from "./index.ts";

describe("init", () => {
  const { setup, setupBootstrapSuccess, track } = useInitHarness();
  test("suppresses auth next-steps when login runs during init", async () => {
    setup({ email: null });
    spyOn(context, "gatherContext").mockResolvedValue(FAKE_CTX);
    spyOn(heuristics, "getAuthenticatedEmail").mockResolvedValue(null);
    spyOn(loginMod, "login").mockResolvedValue({
      userId: "user_1",
      email: "test@test.com",
    } as never);

    await init({ yes: true });

    expect(loginMod.login).toHaveBeenCalledWith({ showNextSteps: false });
    expect(linkMod.link).toHaveBeenCalledWith({
      skipIfLinked: true,
      app: undefined,
      cwd: FAKE_CTX.cwd,
    });
  });

  test("forwards --app to link when provided", async () => {
    setup({ email: "test@test.com" });
    spyOn(context, "gatherContext").mockResolvedValue(FAKE_CTX);
    spyOn(config, "resolveProfile").mockResolvedValue({
      profile: { appId: "app_other" },
    } as never);

    await init({ yes: true, app: "app_abc" });

    expect(linkMod.link).toHaveBeenCalledWith({
      skipIfLinked: true,
      app: "app_abc",
      cwd: FAKE_CTX.cwd,
      createIfMissing: undefined,
    });
  });

  test("forwards --app to link when no profile exists", async () => {
    setup({ email: "test@test.com" });
    spyOn(context, "gatherContext").mockResolvedValue(FAKE_CTX);
    // resolveProfile already returns undefined by default in setup()

    await init({ yes: true, app: "app_abc" });

    expect(linkMod.link).toHaveBeenCalledWith({
      skipIfLinked: true,
      app: "app_abc",
      cwd: FAKE_CTX.cwd,
      createIfMissing: undefined,
    });
  });

  test("agent mode runs existing-project flow without prompts", async () => {
    setup({ isAgent: true });
    spyOn(context, "gatherContext").mockResolvedValue(FAKE_CTX);

    await init({});

    expect(previewMod.previewAndConfirm).not.toHaveBeenCalled();
    expect(bootstrapMod.promptAndBootstrap).not.toHaveBeenCalled();
  });

  test("blank dir in human mode triggers bootstrap flow", async () => {
    setup();
    setupBootstrapSuccess();

    await init({});

    expect(bootstrapMod.promptAndBootstrap).toHaveBeenCalled();
    // React doesn't support keyless, so keyless flow isn't triggered
    expect(heuristics.printKeylessInfo).not.toHaveBeenCalled();
  });

  test("bootstrap flow skips scaffold Proceed? prompt (user already opted in)", async () => {
    setup({ email: "test@test.com" });
    setupBootstrapSuccess();
    spyOn(scaffoldMod, "scaffold").mockResolvedValue({
      actions: [{ type: "create", path: "app/layout.tsx", content: "", description: "" }],
      postInstructions: [],
    });

    await init({});

    expect(bootstrapMod.promptAndBootstrap).toHaveBeenCalled();
    expect(previewMod.previewAndConfirm).not.toHaveBeenCalled();
    expect(previewMod.previewPlan).toHaveBeenCalled();
  });

  test("--starter skips scaffold Proceed? prompt even without -y", async () => {
    setup({ email: "test@test.com" });
    spyOn(context, "gatherContext").mockResolvedValue(FAKE_CTX);
    spyOn(config, "resolveProfile").mockResolvedValue({ profile: { appId: "app_123" } } as never);
    spyOn(scaffoldMod, "scaffold").mockResolvedValue({
      actions: [{ type: "create", path: "app/layout.tsx", content: "", description: "" }],
      postInstructions: [],
    });

    await init({ starter: true });

    expect(previewMod.previewAndConfirm).not.toHaveBeenCalled();
    expect(previewMod.previewPlan).toHaveBeenCalled();
  });

  test("existing project without -y still prompts scaffold Proceed?", async () => {
    setup({ email: "test@test.com" });
    spyOn(context, "gatherContext").mockResolvedValue(FAKE_CTX);
    spyOn(config, "resolveProfile").mockResolvedValue({ profile: { appId: "app_123" } } as never);
    spyOn(scaffoldMod, "scaffold").mockResolvedValue({
      actions: [{ type: "create", path: "app/layout.tsx", content: "", description: "" }],
      postInstructions: [],
    });

    await init({});

    expect(previewMod.previewAndConfirm).toHaveBeenCalled();
  });

  test("bootstrap prints next steps after skills install", async () => {
    setup({ email: "test@test.com" });
    setupBootstrapSuccess();
    spyOn(scaffoldMod, "scaffold").mockResolvedValue({
      actions: [{ type: "create", path: "app/layout.tsx", content: "", description: "" }],
      postInstructions: [],
    });

    const callOrder: string[] = [];
    track(
      spyOn(skillsMod, "installSkills").mockImplementation(async () => {
        callOrder.push("installSkills");
      }),
    );
    track(
      spyOn(nextStepsMod, "printNextSteps").mockImplementation(() => {
        callOrder.push("printNextSteps");
      }),
    );

    await init({});

    expect(callOrder.indexOf("installSkills")).toBeLessThan(callOrder.indexOf("printNextSteps"));
  });

  test("blank dir bootstrap declined throws UserAbortError", async () => {
    setup();
    spyOn(bootstrapMod, "promptAndBootstrap").mockRejectedValue(
      Object.assign(new Error(), { name: "UserAbortError" }),
    );

    await expect(init({})).rejects.toMatchObject({ name: "UserAbortError" });
    expect(bootstrapMod.promptAndBootstrap).toHaveBeenCalled();
    expect(loginMod.login).not.toHaveBeenCalled();
  });

  test("non-empty unrecognized dir throws CliError without auth", async () => {
    setup();
    spyOn(context, "hasPackageJson").mockResolvedValue(true);

    await expect(init({})).rejects.toThrow("Could not detect a framework");
    expect(loginMod.login).not.toHaveBeenCalled();
    expect(bootstrapMod.promptAndBootstrap).not.toHaveBeenCalled();
  });

  test("existing detected project skips bootstrap", async () => {
    setup({ email: "test@test.com" });
    spyOn(context, "gatherContext").mockResolvedValue(FAKE_CTX);
    spyOn(config, "resolveProfile").mockResolvedValue({ profile: { appId: "app_123" } } as never);

    await init({ yes: true });

    expect(bootstrapMod.promptAndBootstrap).not.toHaveBeenCalled();
    expect(context.hasPackageJson).not.toHaveBeenCalled();
  });

  test("passes frameworkOverride to bootstrap when provided", async () => {
    const fwOverride = {
      dep: "next",
      name: "Next.js",
      sdk: "@clerk/nextjs",
      envVar: "NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY",
      envFile: ".env.local" as const,
    };
    setup({ email: "test@test.com" });
    spyOn(frameworkMod, "lookupFramework").mockReturnValue(fwOverride);
    spyOn(config, "resolveProfile").mockResolvedValue({ profile: { appId: "app_123" } } as never);
    // With --framework in a blank dir, resolveProjectContext skips the first
    // gatherContext call and goes straight to bootstrapAndDetect, which calls
    // gatherContext only once on the new project directory.
    spyOn(context, "gatherContext").mockResolvedValueOnce(FAKE_CTX);

    await init({ framework: "next", yes: true });

    expect(bootstrapMod.promptAndBootstrap).toHaveBeenCalledWith(expect.any(String), fwOverride, {
      skipConfirm: true,
      pmOverride: undefined,
      nameOverride: undefined,
    });
  });

  test("--starter skips detection and runs bootstrap with skipConfirm", async () => {
    setup({ email: "test@test.com" });
    spyOn(context, "gatherContext").mockResolvedValue(FAKE_CTX);
    spyOn(config, "resolveProfile").mockResolvedValue({ profile: { appId: "app_123" } } as never);

    await init({ starter: true, yes: true });

    expect(bootstrapMod.promptAndBootstrap).toHaveBeenCalledWith(
      expect.any(String),
      undefined,
      expect.objectContaining({
        skipConfirm: true,
        implicitBootstrap: true,
        pmOverride: undefined,
        nameOverride: undefined,
      }),
    );
    // --yes skips confirmOverwrite
    expect(bootstrapMod.confirmOverwrite).not.toHaveBeenCalled();
  });

  test("--starter without -y calls confirmOverwrite", async () => {
    setup({ email: "test@test.com" });
    spyOn(context, "gatherContext").mockResolvedValue(FAKE_CTX);
    spyOn(config, "resolveProfile").mockResolvedValue({ profile: { appId: "app_123" } } as never);

    await init({ starter: true });

    expect(bootstrapMod.confirmOverwrite).toHaveBeenCalledWith(expect.any(String));
  });

  test("--starter without -y runs bootstrap interactively (does not require --framework)", async () => {
    setup({ email: "test@test.com" });
    spyOn(context, "gatherContext").mockResolvedValue(FAKE_CTX);
    spyOn(config, "resolveProfile").mockResolvedValue({ profile: { appId: "app_123" } } as never);

    await init({ starter: true });

    expect(bootstrapMod.promptAndBootstrap).toHaveBeenCalledWith(
      expect.any(String),
      undefined,
      expect.objectContaining({ skipConfirm: false, implicitBootstrap: true }),
    );
  });

  test("bootstrap passes project dir to installSkills, not original cwd", async () => {
    setup();

    const bootstrapCtx = {
      ...FAKE_CTX,
      cwd: FAKE_BOOTSTRAP.projectDir,
      existingClerk: false,
    };

    spyOn(context, "gatherContext").mockResolvedValueOnce(null).mockResolvedValueOnce(bootstrapCtx);

    spyOn(scaffoldMod, "scaffold").mockResolvedValue({
      actions: [{ type: "create", path: "app/layout.tsx", content: "", description: "" }],
      postInstructions: [],
    });

    await init({ yes: true });

    expect(skillsMod.installSkills).toHaveBeenCalledWith(
      FAKE_BOOTSTRAP.projectDir,
      "react",
      "npm",
      true,
    );
  });

  test("--framework in blank dir triggers bootstrap (not existing-project flow)", async () => {
    const fwOverride = {
      dep: "next",
      name: "Next.js",
      sdk: "@clerk/nextjs",
      envVar: "NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY",
      envFile: ".env.local" as const,
      supportsKeyless: true,
    };
    setup();
    spyOn(context, "hasPackageJson").mockResolvedValue(false);
    spyOn(frameworkMod, "lookupFramework").mockReturnValue(fwOverride);

    // After bootstrap, gatherContext is called again on the new project dir.
    const bootstrapCtx = {
      ...FAKE_CTX,
      cwd: FAKE_BOOTSTRAP.projectDir,
      framework: fwOverride,
      existingClerk: false,
    };
    spyOn(context, "gatherContext").mockResolvedValueOnce(bootstrapCtx);

    spyOn(scaffoldMod, "scaffold").mockResolvedValue({
      actions: [{ type: "create", path: "middleware.ts", content: "", description: "" }],
      postInstructions: [],
    });

    await init({ framework: "next", yes: true });

    expect(bootstrapMod.promptAndBootstrap).toHaveBeenCalledWith(
      expect.any(String),
      fwOverride,
      expect.objectContaining({ skipConfirm: true }),
    );
  });

  test("--framework with --pm in blank dir triggers bootstrap with correct pm", async () => {
    const fwOverride = {
      dep: "next",
      name: "Next.js",
      sdk: "@clerk/nextjs",
      envVar: "NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY",
      envFile: ".env.local" as const,
      supportsKeyless: true,
    };
    setup();
    spyOn(context, "hasPackageJson").mockResolvedValue(false);
    spyOn(frameworkMod, "lookupFramework").mockReturnValue(fwOverride);

    const bootstrapCtx = {
      ...FAKE_CTX,
      cwd: FAKE_BOOTSTRAP.projectDir,
      framework: fwOverride,
      existingClerk: false,
    };
    spyOn(context, "gatherContext").mockResolvedValueOnce(bootstrapCtx);

    spyOn(scaffoldMod, "scaffold").mockResolvedValue({
      actions: [{ type: "create", path: "middleware.ts", content: "", description: "" }],
      postInstructions: [],
    });

    await init({ framework: "next", pm: "npm", yes: true });

    expect(bootstrapMod.promptAndBootstrap).toHaveBeenCalledWith(
      expect.any(String),
      fwOverride,
      expect.objectContaining({ skipConfirm: true, pmOverride: "npm" }),
    );
  });

  test("--starter in agent mode runs bootstrap with skipConfirm", async () => {
    setup({ isAgent: true });
    spyOn(context, "gatherContext").mockResolvedValue(FAKE_CTX);

    await init({ starter: true, framework: "react" });

    expect(bootstrapMod.promptAndBootstrap).toHaveBeenCalledWith(
      expect.any(String),
      undefined,
      expect.objectContaining({ skipConfirm: true }),
    );
    expect(bootstrapMod.confirmOverwrite).not.toHaveBeenCalled();
  });

  test("short-circuits env pull and skills install when already set up", async () => {
    const { gatherContextSpy } = setup({ email: "test@test.com" });

    gatherContextSpy.mockResolvedValueOnce({
      cwd: "/tmp/fake",
      framework: { name: "Next.js", dep: "next", sdk: "@clerk/nextjs", publishableKeyEnv: "x" },
      deps: { next: "15.0.0" },
      packageManager: "bun",
      typescript: true,
      srcDir: false,
      existingClerk: true,
    } as never);

    await init({ yes: true });

    expect(linkMod.link).toHaveBeenCalledWith({
      skipIfLinked: true,
      app: undefined,
      cwd: "/tmp/fake",
    });
    expect(pullMod.pull).not.toHaveBeenCalled();
    expect(heuristics.printKeylessInfo).not.toHaveBeenCalled();
    expect(skillsMod.installSkills).not.toHaveBeenCalled();
  });

  test("--pm overrides detected package manager in existing-project flow", async () => {
    setup({ email: "test@test.com" });
    spyOn(context, "gatherContext").mockResolvedValue(FAKE_CTX);
    spyOn(config, "resolveProfile").mockResolvedValue({ profile: { appId: "app_123" } } as never);

    await init({ pm: "pnpm", yes: true });

    expect(context.gatherContext).toHaveBeenCalledWith(expect.any(String), undefined, "pnpm");
  });

  test("--pm and --name are threaded to bootstrap", async () => {
    setup({ email: "test@test.com" });
    spyOn(context, "gatherContext").mockResolvedValue(FAKE_CTX);
    spyOn(config, "resolveProfile").mockResolvedValue({ profile: { appId: "app_123" } } as never);

    await init({ starter: true, yes: true, pm: "bun", name: "my-project" });

    expect(bootstrapMod.promptAndBootstrap).toHaveBeenCalledWith(
      expect.any(String),
      undefined,
      expect.objectContaining({
        skipConfirm: true,
        implicitBootstrap: true,
        pmOverride: "bun",
        nameOverride: "my-project",
      }),
    );
  });

  test("agent mode skips all confirmations implicitly", async () => {
    setup({ isAgent: true });
    spyOn(context, "gatherContext").mockResolvedValue(FAKE_CTX);

    await init({});

    // installSkills receives skipConfirm=true from agent mode
    expect(skillsMod.installSkills).not.toHaveBeenCalled(); // alreadySetUp short-circuits
  });

  test("pulls env to ctx.envFile when authenticated and framework detected", async () => {
    const { gatherContextSpy } = setup({ email: "test@test.com" });

    const mockCtx = {
      cwd: process.cwd(),
      framework: {
        dep: "next",
        name: "Next.js",
        sdk: "@clerk/nextjs",
        envVar: "NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY",
        envFile: ".env.local" as const,
      },
      typescript: true,
      srcDir: false,
      packageManager: "npm" as const,
      existingClerk: false,
      deps: { next: "15.0.0" },
      envFile: ".env.local",
    };

    gatherContextSpy.mockResolvedValue(mockCtx);
    spyOn(scaffoldMod, "scaffold").mockResolvedValue({
      actions: [{ type: "create", path: "app/layout.tsx", content: "", description: "" }],
      postInstructions: [],
    });

    await init({ yes: true });

    expect(pullMod.pull).toHaveBeenCalledWith({ file: ".env.local", cwd: mockCtx.cwd });
  });

  test("native framework skips npm SDK install but still pulls env keys", async () => {
    setup({ email: "test@test.com" });

    const iosCtx = {
      ...FAKE_CTX,
      existingClerk: false,
      deps: {},
      envFile: ".env",
      framework: {
        dep: "ios",
        name: "iOS (Swift)",
        sdk: "ClerkKit",
        envVar: "CLERK_PUBLISHABLE_KEY",
        envFile: ".env" as const,
        ecosystem: "swift" as const,
      },
    };
    spyOn(context, "gatherContext").mockResolvedValue(iosCtx);
    spyOn(scaffoldMod, "scaffold").mockResolvedValue({
      actions: [],
      postInstructions: ["Add the Clerk iOS SDK via Swift Package Manager"],
    });

    await init({ yes: true });

    expect(heuristics.installSdk).not.toHaveBeenCalled();
    expect(pullMod.pull).toHaveBeenCalledWith({ file: ".env", cwd: iosCtx.cwd });
  });

  test("native framework skips the agent skills install prompt", async () => {
    setup({ email: "test@test.com" });

    const iosCtx = {
      ...FAKE_CTX,
      existingClerk: false,
      deps: {},
      envFile: ".env",
      framework: {
        dep: "ios",
        name: "iOS (Swift)",
        sdk: "ClerkKit",
        envVar: "CLERK_PUBLISHABLE_KEY",
        envFile: ".env" as const,
        ecosystem: "swift" as const,
      },
    };
    spyOn(context, "gatherContext").mockResolvedValue(iosCtx);
    spyOn(scaffoldMod, "scaffold").mockResolvedValue({
      actions: [],
      postInstructions: ["Add the Clerk iOS SDK via Swift Package Manager"],
    });

    await init({ yes: true });

    expect(skillsMod.installSkills).not.toHaveBeenCalled();
  });

  test("--framework ios without package.json does not trigger bootstrap", async () => {
    setup({ email: "test@test.com" });

    const iosFramework = {
      dep: "ios",
      name: "iOS (Swift)",
      sdk: "ClerkKit",
      envVar: "CLERK_PUBLISHABLE_KEY",
      envFile: ".env" as const,
      ecosystem: "swift" as const,
    };
    const iosCtx = {
      ...FAKE_CTX,
      existingClerk: false,
      deps: {},
      envFile: ".env",
      framework: iosFramework,
    };
    spyOn(frameworkMod, "lookupFramework").mockReturnValue(iosFramework);
    spyOn(context, "gatherContext").mockResolvedValue(iosCtx);
    spyOn(context, "hasPackageJson").mockResolvedValue(false);
    spyOn(scaffoldMod, "scaffold").mockResolvedValue({
      actions: [],
      postInstructions: ["Add the Clerk iOS SDK via Swift Package Manager"],
    });

    await init({ yes: true, framework: "ios" });

    expect(bootstrapMod.promptAndBootstrap).not.toHaveBeenCalled();
    expect(pullMod.pull).toHaveBeenCalled();
  });

  test("bootstrap passes project dir to link, not parent cwd", async () => {
    setup({ email: "test@test.com" });

    const bootstrapCtx = {
      ...FAKE_CTX,
      cwd: FAKE_BOOTSTRAP.projectDir,
      existingClerk: false,
    };

    spyOn(context, "gatherContext").mockResolvedValueOnce(null).mockResolvedValueOnce(bootstrapCtx);
    spyOn(scaffoldMod, "scaffold").mockResolvedValue({
      actions: [{ type: "create", path: "app/layout.tsx", content: "", description: "" }],
      postInstructions: [],
    });

    await init({ yes: true });

    expect(linkMod.link).toHaveBeenCalledWith({
      skipIfLinked: true,
      app: undefined,
      cwd: FAKE_BOOTSTRAP.projectDir,
    });
  });

  describe("telemetry stages", () => {
    /** Spy registered with the harness so its calls reset between tests. */
    function trackStages() {
      const stage = spyOn(telemetryMod, "setTelemetryStage");
      track(stage);
      return () => stage.mock.calls.map((call) => call[0]);
    }

    test("a completed run reports the terminal stage", async () => {
      setup({ email: "test@test.com" });
      mockExistingProject(FAKE_CTX);
      mockMiddlewareScaffold();
      const stages = trackStages();

      await init({ yes: true });

      expect(stages().at(-1)).toBe("done");
    });

    test("a run with nothing to do stops at already_set_up", async () => {
      setup({ email: "test@test.com" });
      mockExistingProject(FAKE_CTX);
      const stages = trackStages();

      await init({ yes: true });

      expect(stages().at(-1)).toBe("already_set_up");
    });

    // A run that dies in flag validation must not claim any later stage —
    // that's what makes the funnel readable.
    test("a rejected flag combination stops at the flags stage", async () => {
      setup({ email: "test@test.com" });
      const stages = trackStages();

      await expect(init({ accountless: true, login: true })).rejects.toThrow();

      expect(stages()).toEqual(["flags"]);
    });

    test("declining the scaffold preview stops at the scaffold stage", async () => {
      setup({ email: "test@test.com" });
      mockExistingProject(FAKE_CTX);
      mockMiddlewareScaffold();
      track(spyOn(previewMod, "previewAndConfirm").mockResolvedValue(false));
      const stages = trackStages();

      await expect(init({})).rejects.toThrow();

      expect(stages().at(-1)).toBe("scaffold");
    });

    // Declining the overwrite prompt is the default answer on --starter, so it
    // is a common drop-off — and it happens before bootstrapAndDetect runs.
    test("declining the starter overwrite prompt stops at the bootstrap stage", async () => {
      setup({ email: "test@test.com" });
      spyOn(context, "gatherContext").mockResolvedValue(FAKE_CTX);
      spyOn(config, "resolveProfile").mockResolvedValue({ profile: { appId: "app_123" } } as never);
      track(
        spyOn(bootstrapMod, "confirmOverwrite").mockRejectedValue(
          Object.assign(new Error(), { name: "UserAbortError" }),
        ),
      );
      const stages = trackStages();

      await expect(init({ starter: true })).rejects.toMatchObject({ name: "UserAbortError" });

      expect(stages().at(-1)).toBe("bootstrap");
    });

    test("a failure inside the generator stops at the bootstrap stage", async () => {
      setup();
      track(spyOn(bootstrapMod, "promptAndBootstrap").mockRejectedValue(new Error("gen failed")));
      const stages = trackStages();

      await expect(init({})).rejects.toThrow();

      expect(stages().at(-1)).toBe("bootstrap");
    });
  });
});
