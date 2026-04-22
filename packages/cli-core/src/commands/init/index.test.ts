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
import * as nextStepsMod from "../../lib/next-steps.ts";
import * as keylessMod from "../../lib/keyless.ts";
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

  function setup(overrides: { email?: string | null; apiKey?: boolean; isAgent?: boolean } = {}) {
    const email = overrides.email ?? null;
    const apiKey = overrides.apiKey ?? false;
    const agent = overrides.isAgent ?? false;
    const authed = email != null || apiKey;

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
      spyOn(heuristics, "isAuthenticated").mockResolvedValue(authed),
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
      spyOn(keylessMod, "createAccountlessApp").mockResolvedValue({
        publishable_key: "pk_test_stub",
        secret_key: "sk_test_stub",
        claim_url: "/apps/claim?token=stub_token",
      }),
      spyOn(keylessMod, "writeKeysToEnvFile").mockResolvedValue(undefined),
      spyOn(keylessMod, "writeKeylessBreadcrumb").mockResolvedValue(undefined),
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
    });
  });

  test("agent mode runs existing-project flow without prompts", async () => {
    setup({ isAgent: true });
    spyOn(context, "gatherContext").mockResolvedValue(FAKE_CTX);

    await init({});

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
    spies.push(
      spyOn(skillsMod, "installSkills").mockImplementation(async () => {
        callOrder.push("installSkills");
      }),
    );
    spies.push(
      spyOn(nextStepsMod, "printNextSteps").mockImplementation(() => {
        callOrder.push("printNextSteps");
      }),
    );

    await init({});

    expect(callOrder.indexOf("installSkills")).toBeLessThan(callOrder.indexOf("printNextSteps"));
  });

  test("blank dir with keyless framework auto-selects keyless when unauthenticated", async () => {
    setup();

    const keylessCtx = {
      ...FAKE_CTX,
      existingClerk: false,
      framework: {
        ...FAKE_CTX.framework,
        supportsKeyless: true,
      },
    };
    spyOn(context, "gatherContext").mockResolvedValueOnce(null).mockResolvedValueOnce(keylessCtx);
    spyOn(scaffoldMod, "scaffold").mockResolvedValue({
      actions: [{ type: "create", path: "middleware.ts", content: "", description: "" }],
      postInstructions: [],
    });

    await init({});

    expect(bootstrapMod.promptAndBootstrap).toHaveBeenCalled();
    expect(heuristics.printKeylessInfo).toHaveBeenCalled();
    expect(linkMod.link).not.toHaveBeenCalled();
  });

  test("bootstrap with keyless framework goes authenticated when already signed in", async () => {
    setup({ email: "user@example.com" });

    const keylessCtx = {
      ...FAKE_CTX,
      framework: { ...FAKE_CTX.framework, supportsKeyless: true },
    };
    spyOn(context, "gatherContext").mockResolvedValueOnce(null).mockResolvedValueOnce(keylessCtx);

    await init({});

    expect(heuristics.isAuthenticated).toHaveBeenCalled();
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

    expect(heuristics.isAuthenticated).toHaveBeenCalled();
    expect(heuristics.printKeylessInfo).not.toHaveBeenCalled();
  });

  test("-y flag with keyless framework uses authenticated flow when CLERK_PLATFORM_API_KEY is set", async () => {
    setup({ apiKey: true });

    const keylessCtx = {
      ...FAKE_CTX,
      framework: { ...FAKE_CTX.framework, supportsKeyless: true },
    };
    spyOn(context, "gatherContext").mockResolvedValueOnce(null).mockResolvedValueOnce(keylessCtx);

    await init({ yes: true });

    expect(heuristics.isAuthenticated).toHaveBeenCalled();
    expect(heuristics.printKeylessInfo).not.toHaveBeenCalled();
    expect(linkMod.link).toHaveBeenCalled();
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

    expect(heuristics.isAuthenticated).toHaveBeenCalled();
    expect(heuristics.printKeylessInfo).toHaveBeenCalled();
    expect(linkMod.link).not.toHaveBeenCalled();
  });

  test("-y flag skips auth prompt and defaults to unauthenticated mode", async () => {
    setup();
    setupBootstrapSuccess();

    await init({ yes: true });

    expect(bootstrapMod.promptAndBootstrap).toHaveBeenCalled();
    // isAuthenticated is called during skipAuth check
    expect(heuristics.isAuthenticated).toHaveBeenCalled();
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
    // isAuthenticated is called during skipAuth check, returns false → skip auth
    expect(heuristics.isAuthenticated).toHaveBeenCalled();
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

  test("existing repo with keyless framework uses authenticated flow when signed in", async () => {
    setup({ email: "user@example.com" });

    const keylessCtx = {
      ...FAKE_CTX,
      framework: { ...FAKE_CTX.framework, supportsKeyless: true },
    };
    spyOn(context, "gatherContext").mockResolvedValue(keylessCtx);
    spyOn(config, "resolveProfile").mockResolvedValue({ profile: { appId: "app_123" } } as never);

    await init({ yes: true });

    expect(bootstrapMod.promptAndBootstrap).not.toHaveBeenCalled();
    expect(heuristics.isAuthenticated).toHaveBeenCalled();
    expect(heuristics.printKeylessInfo).not.toHaveBeenCalled();
  });

  test("existing repo with keyless framework uses authenticated flow when not signed in", async () => {
    // Keyless auto-selection is scoped to bootstrap (new-project) flows. On an
    // existing repo, an unauthenticated re-run should fall through to the
    // authenticated flow (which prompts login) rather than silently skip
    // `env pull` and scaffold permissive middleware.
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
    spyOn(loginMod, "login").mockResolvedValue({
      userId: "user_1",
      email: "test@test.com",
    } as never);

    await init({});

    expect(bootstrapMod.promptAndBootstrap).not.toHaveBeenCalled();
    expect(heuristics.isAuthenticated).toHaveBeenCalled();
    expect(heuristics.printKeylessInfo).not.toHaveBeenCalled();
    // Unauthenticated + existing repo → login + link run via authenticateAndLink.
    expect(loginMod.login).toHaveBeenCalledWith({ showNextSteps: false });
    expect(linkMod.link).toHaveBeenCalled();
    expect(pullMod.pull).toHaveBeenCalled();
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
});
