import { test, expect, describe, afterEach, spyOn } from "bun:test";
import { captureLog } from "../../test/lib/stubs.ts";

// Pure spyOn approach — Bun's mock.module globally replaces modules for the
// entire test run, which pollutes other test files (link, env/pull, config,
// context, etc.) that import the same modules. spyOn restores cleanly.
import * as loginMod from "../auth/login.ts";
import * as linkMod from "../link/index.ts";
import * as pullMod from "../env/pull.ts";
import * as mode from "../../mode.ts";
import * as config from "../../lib/config.ts";
import * as frameworkMod from "../../lib/framework.ts";
import * as context from "./context.ts";
import * as scaffoldMod from "./scaffold.ts";
import * as previewMod from "./preview.ts";
import * as formatMod from "./format.ts";
import * as scanMod from "./scan.ts";
import * as heuristics from "./heuristics.ts";
import * as skillsMod from "./skills.ts";
import * as bootstrapMod from "./bootstrap.ts";
import { init } from "./index.ts";

const FAKE_CTX = {
  cwd: "/tmp/test",
  framework: {
    dep: "react",
    name: "React",
    sdk: "@clerk/react",
    envVar: "VITE_CLERK_PUBLISHABLE_KEY",
    envFile: ".env" as const,
  },
  typescript: true,
  srcDir: false,
  packageManager: "npm" as const,
  existingClerk: true,
  deps: { react: "^19.0.0" },
  envFile: ".env",
};

const FAKE_BOOTSTRAP = {
  projectDir: "/tmp/test/my-app",
  projectName: "my-app",
  packageManager: "npm" as const,
};

describe("init", () => {
  let spies: ReturnType<typeof spyOn>[];
  let captured: ReturnType<typeof captureLog>;

  afterEach(() => {
    captured.teardown();
    for (const s of spies) s.mockRestore();
  });

  function setup(overrides: { email?: string | null; isAgent?: boolean } = {}) {
    const email = overrides.email ?? null;
    const agent = overrides.isAgent ?? false;

    captured = captureLog();

    const gatherContextSpy = spyOn(context, "gatherContext").mockResolvedValue(null);

    spies = [
      spyOn(mode, "isAgent").mockReturnValue(agent),
      spyOn(mode, "isHuman").mockReturnValue(!agent),
      spyOn(config, "resolveProfile").mockResolvedValue(undefined),
      spyOn(frameworkMod, "lookupFramework").mockReturnValue(null),
      gatherContextSpy,
      spyOn(context, "hasPackageJson").mockResolvedValue(false),
      spyOn(scaffoldMod, "scaffold").mockResolvedValue({ actions: [], postInstructions: [] }),
      spyOn(scaffoldMod, "enrichProjectContext").mockResolvedValue(undefined),
      spyOn(previewMod, "previewPlan").mockReturnValue(undefined),
      spyOn(previewMod, "previewAndConfirm").mockResolvedValue(true),
      spyOn(formatMod, "runFormatters").mockResolvedValue(undefined),
      spyOn(scanMod, "detectAuthLibraries").mockReturnValue(undefined),
      spyOn(scanMod, "scanForIssues").mockResolvedValue([]),
      spyOn(heuristics, "getAuthenticatedEmail").mockResolvedValue(email),
      spyOn(heuristics, "printKeylessInfo").mockReturnValue(undefined),
      spyOn(heuristics, "installSdk").mockResolvedValue(undefined),
      spyOn(heuristics, "installDeps").mockResolvedValue(undefined),
      spyOn(heuristics, "writePlan").mockResolvedValue([]),
      spyOn(heuristics, "checkGitDirty").mockResolvedValue(false),
      spyOn(heuristics, "printOutro").mockReturnValue(undefined),
      spyOn(skillsMod, "installSkills").mockResolvedValue(undefined),
      spyOn(loginMod, "login").mockResolvedValue(undefined as never),
      spyOn(linkMod, "link").mockResolvedValue(undefined),
      spyOn(pullMod, "pull").mockResolvedValue(undefined),
      spyOn(bootstrapMod, "promptAndBootstrap").mockResolvedValue(FAKE_BOOTSTRAP),
      spyOn(bootstrapMod, "confirmOverwrite").mockResolvedValue(undefined),
      spyOn(bootstrapMod, "askSkipAuth").mockResolvedValue(false),
    ];

    return { gatherContextSpy, captured };
  }

  function setupBootstrapSuccess() {
    const gatherSpy =
      spies.find((s) => s.getMockName?.() === "gatherContext") ?? spyOn(context, "gatherContext");
    gatherSpy.mockResolvedValueOnce(null).mockResolvedValueOnce(FAKE_CTX);
  }

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
    expect(linkMod.link).toHaveBeenCalledWith({ skipIfLinked: true, app: undefined });
  });

  test("forwards --app to link when provided", async () => {
    setup({ email: "test@test.com" });
    spyOn(context, "gatherContext").mockResolvedValue(FAKE_CTX);
    spyOn(config, "resolveProfile").mockResolvedValue({
      profile: { appId: "app_other" },
    } as never);

    await init({ yes: true, app: "app_abc" });

    expect(linkMod.link).toHaveBeenCalledWith({ skipIfLinked: true, app: "app_abc" });
  });

  test("forwards --app to link when no profile exists", async () => {
    setup({ email: "test@test.com" });
    spyOn(context, "gatherContext").mockResolvedValue(FAKE_CTX);
    // resolveProfile already returns undefined by default in setup()

    await init({ yes: true, app: "app_abc" });

    expect(linkMod.link).toHaveBeenCalledWith({ skipIfLinked: true, app: "app_abc" });
  });

  test("agent mode runs existing-project flow without prompts", async () => {
    setup({ isAgent: true });
    spyOn(context, "gatherContext").mockResolvedValue(FAKE_CTX);

    await init({});

    expect(bootstrapMod.askSkipAuth).not.toHaveBeenCalled();
    expect(previewMod.previewAndConfirm).not.toHaveBeenCalled();
    expect(bootstrapMod.promptAndBootstrap).not.toHaveBeenCalled();
  });

  test("--prompt flag prints guidance and exits", async () => {
    const { captured } = setup({ isAgent: false });

    await captured.run(() => init({ prompt: true }));

    expect(captured.out).toContain("clerk init -y");
    expect(loginMod.login).not.toHaveBeenCalled();
    expect(bootstrapMod.promptAndBootstrap).not.toHaveBeenCalled();
  });

  test("blank dir in human mode triggers bootstrap flow", async () => {
    setup();
    setupBootstrapSuccess();

    await init({});

    expect(bootstrapMod.promptAndBootstrap).toHaveBeenCalled();
    // React doesn't support keyless, so askSkipAuth is never called
    expect(bootstrapMod.askSkipAuth).not.toHaveBeenCalled();
  });

  test("blank dir with keyless framework prompts askSkipAuth", async () => {
    setup();

    const keylessCtx = {
      ...FAKE_CTX,
      framework: {
        ...FAKE_CTX.framework,
        supportsKeyless: true,
      },
    };
    spyOn(context, "gatherContext").mockResolvedValueOnce(null).mockResolvedValueOnce(keylessCtx);

    await init({});

    expect(bootstrapMod.promptAndBootstrap).toHaveBeenCalled();
    expect(bootstrapMod.askSkipAuth).toHaveBeenCalled();
  });

  test("bootstrap with keyless framework skips askSkipAuth when already authenticated", async () => {
    setup({ email: "user@example.com" });

    const keylessCtx = {
      ...FAKE_CTX,
      framework: { ...FAKE_CTX.framework, supportsKeyless: true },
    };
    spyOn(context, "gatherContext").mockResolvedValueOnce(null).mockResolvedValueOnce(keylessCtx);

    await init({});

    expect(heuristics.getAuthenticatedEmail).toHaveBeenCalled();
    expect(bootstrapMod.askSkipAuth).not.toHaveBeenCalled();
    expect(heuristics.printKeylessInfo).not.toHaveBeenCalled();
    expect(linkMod.link).toHaveBeenCalled();
  });

  test("-y flag with keyless framework uses authenticated flow when signed in", async () => {
    setup({ email: "user@example.com" });

    const keylessCtx = {
      ...FAKE_CTX,
      framework: { ...FAKE_CTX.framework, supportsKeyless: true },
    };
    spyOn(context, "gatherContext").mockResolvedValueOnce(null).mockResolvedValueOnce(keylessCtx);

    await init({ yes: true });

    expect(heuristics.getAuthenticatedEmail).toHaveBeenCalled();
    expect(bootstrapMod.askSkipAuth).not.toHaveBeenCalled();
    expect(heuristics.printKeylessInfo).not.toHaveBeenCalled();
  });

  test("-y flag with keyless framework goes keyless when not authenticated", async () => {
    setup();

    const keylessCtx = {
      ...FAKE_CTX,
      existingClerk: false,
      framework: { ...FAKE_CTX.framework, supportsKeyless: true },
    };
    spyOn(context, "gatherContext").mockResolvedValueOnce(null).mockResolvedValueOnce(keylessCtx);
    spyOn(scaffoldMod, "scaffold").mockResolvedValue({
      actions: [{ type: "create", path: "middleware.ts", content: "", description: "" }],
      postInstructions: [],
    });

    await init({ yes: true });

    expect(heuristics.getAuthenticatedEmail).toHaveBeenCalled();
    expect(bootstrapMod.askSkipAuth).not.toHaveBeenCalled();
    expect(heuristics.printKeylessInfo).toHaveBeenCalled();
    expect(linkMod.link).not.toHaveBeenCalled();
  });

  test("-y flag skips auth prompt and defaults to unauthenticated mode", async () => {
    setup();
    setupBootstrapSuccess();

    await init({ yes: true });

    expect(bootstrapMod.promptAndBootstrap).toHaveBeenCalled();
    expect(bootstrapMod.askSkipAuth).not.toHaveBeenCalled();
    // getAuthenticatedEmail is called during skipAuth check
    expect(heuristics.getAuthenticatedEmail).toHaveBeenCalled();
  });

  test("-y flag skips auth for frameworks without keyless support in bootstrap", async () => {
    setup();

    const noKeylessCtx = {
      ...FAKE_CTX,
      framework: {
        dep: "vue",
        name: "Vue",
        sdk: "@clerk/vue",
        envVar: "VITE_CLERK_PUBLISHABLE_KEY",
        envFile: ".env.local" as const,
      },
      existingClerk: false,
    };

    spyOn(context, "gatherContext").mockResolvedValueOnce(null).mockResolvedValueOnce(noKeylessCtx);

    await init({ yes: true });

    expect(bootstrapMod.promptAndBootstrap).toHaveBeenCalled();
    // Should not ask about skipping auth — keyless not supported
    expect(bootstrapMod.askSkipAuth).not.toHaveBeenCalled();
    // getAuthenticatedEmail is called during skipAuth check, returns null → skip auth
    expect(heuristics.getAuthenticatedEmail).toHaveBeenCalled();
    expect(loginMod.login).not.toHaveBeenCalled();
    expect(heuristics.printKeylessInfo).not.toHaveBeenCalled();
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

  test("existing repo with keyless framework skips askSkipAuth when signed in", async () => {
    setup({ email: "user@example.com" });

    const keylessCtx = {
      ...FAKE_CTX,
      framework: { ...FAKE_CTX.framework, supportsKeyless: true },
    };
    spyOn(context, "gatherContext").mockResolvedValue(keylessCtx);
    spyOn(config, "resolveProfile").mockResolvedValue({ profile: { appId: "app_123" } } as never);

    await init({ yes: true });

    expect(bootstrapMod.promptAndBootstrap).not.toHaveBeenCalled();
    expect(heuristics.getAuthenticatedEmail).toHaveBeenCalled();
    expect(bootstrapMod.askSkipAuth).not.toHaveBeenCalled();
    expect(heuristics.printKeylessInfo).not.toHaveBeenCalled();
  });

  test("existing repo with keyless framework prompts askSkipAuth when not signed in", async () => {
    setup();

    const keylessCtx = {
      ...FAKE_CTX,
      existingClerk: false,
      framework: { ...FAKE_CTX.framework, supportsKeyless: true },
    };
    spyOn(context, "gatherContext").mockResolvedValue(keylessCtx);
    spyOn(scaffoldMod, "scaffold").mockResolvedValue({
      actions: [{ type: "create", path: "middleware.ts", content: "", description: "" }],
      postInstructions: [],
    });

    await init({});

    expect(bootstrapMod.promptAndBootstrap).not.toHaveBeenCalled();
    expect(heuristics.getAuthenticatedEmail).toHaveBeenCalled();
    expect(bootstrapMod.askSkipAuth).toHaveBeenCalled();
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
    setupBootstrapSuccess();

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

    expect(bootstrapMod.promptAndBootstrap).toHaveBeenCalledWith(expect.any(String), undefined, {
      skipConfirm: true,
      pmOverride: undefined,
      nameOverride: undefined,
    });
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

    expect(linkMod.link).toHaveBeenCalledWith({ skipIfLinked: true });
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

    expect(bootstrapMod.promptAndBootstrap).toHaveBeenCalledWith(expect.any(String), undefined, {
      skipConfirm: true,
      pmOverride: "bun",
      nameOverride: "my-project",
    });
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
        envFile: ".env" as const,
      },
      typescript: true,
      srcDir: false,
      packageManager: "npm" as const,
      existingClerk: false,
      deps: { next: "15.0.0" },
      envFile: ".env",
    };

    gatherContextSpy.mockResolvedValue(mockCtx);
    spyOn(scaffoldMod, "scaffold").mockResolvedValue({
      actions: [{ type: "create", path: "app/layout.tsx", content: "", description: "" }],
      postInstructions: [],
    });

    await init({ yes: true });

    expect(pullMod.pull).toHaveBeenCalledWith({ file: ".env" });
  });
});
