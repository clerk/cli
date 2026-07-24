import { test, expect, describe, spyOn } from "bun:test";

// Pure spyOn approach — Bun's mock.module globally replaces modules for the
// entire test run, which pollutes other test files that import the same
// modules. spyOn restores cleanly. Shared setup lives in the harness.
import {
  useInitHarness,
  FAKE_CTX,
  KEYLESS_CTX,
  mockBootstrapTo,
  mockExistingProject,
  mockMiddlewareScaffold,
  type FakeCtx,
  loginMod,
  linkMod,
  pullMod,
  config,
  context,
  scaffoldMod,
  heuristics,
  bootstrapMod,
  keylessMod,
} from "../../test/lib/init-harness.ts";
import { init } from "./index.ts";

describe("init strategy", () => {
  const { setup, setupBootstrapSuccess } = useInitHarness();
  test("blank dir with keyless framework defaults to keyless when unauthenticated", async () => {
    setup();
    mockBootstrapTo(KEYLESS_CTX);
    mockMiddlewareScaffold();

    await init({});

    expect(bootstrapMod.promptAndBootstrap).toHaveBeenCalled();
    // Keyless is the default for unauthenticated bootstrap; login is opt-in via --login.
    expect(keylessMod.createAccountlessApp).toHaveBeenCalled();
    expect(keylessMod.writeKeylessBreadcrumb).toHaveBeenCalled();
    expect(heuristics.printKeylessInfo).toHaveBeenCalled();
    expect(loginMod.login).not.toHaveBeenCalled();
    expect(linkMod.link).not.toHaveBeenCalled();
  });

  test("--login on unauthenticated bootstrap forces the authenticated flow", async () => {
    setup();
    mockBootstrapTo(KEYLESS_CTX);
    mockMiddlewareScaffold();

    await init({ login: true });

    expect(heuristics.printKeylessInfo).not.toHaveBeenCalled();
    expect(keylessMod.createAccountlessApp).not.toHaveBeenCalled();
    expect(loginMod.login).toHaveBeenCalledWith({ showNextSteps: false });
    expect(linkMod.link).toHaveBeenCalled();
  });

  test("--template is forwarded to the keyless application create call", async () => {
    setup();
    mockBootstrapTo(KEYLESS_CTX);
    mockMiddlewareScaffold();

    await init({ template: "b2b-saas" });

    expect(keylessMod.createAccountlessApp).toHaveBeenCalledWith(
      KEYLESS_CTX.framework.dep,
      "b2b-saas",
    );
  });

  test("--template with --login throws a usage error", async () => {
    setup();

    await expect(init({ template: "b2b-saas", login: true })).rejects.toThrow(
      /--template applies to keyless applications/,
    );
    expect(bootstrapMod.promptAndBootstrap).not.toHaveBeenCalled();
  });

  test("--keyless with --login throws a usage error before bootstrapping", async () => {
    setup();

    await expect(init({ keyless: true, login: true })).rejects.toThrow(
      /--keyless and --login cannot be combined/,
    );
    expect(bootstrapMod.promptAndBootstrap).not.toHaveBeenCalled();
    expect(keylessMod.createAccountlessApp).not.toHaveBeenCalled();
    expect(loginMod.login).not.toHaveBeenCalled();
  });

  test("--keyless with --app throws a usage error before bootstrapping", async () => {
    setup();

    await expect(init({ keyless: true, app: "app_abc" })).rejects.toThrow(
      /--keyless cannot be combined with --app/,
    );
    expect(bootstrapMod.promptAndBootstrap).not.toHaveBeenCalled();
    expect(keylessMod.createAccountlessApp).not.toHaveBeenCalled();
    expect(linkMod.link).not.toHaveBeenCalled();
  });

  test("--keyless on a keyless-capable framework uses keyless mode without logging in", async () => {
    setup();
    mockBootstrapTo(KEYLESS_CTX);
    mockMiddlewareScaffold();

    await init({ keyless: true });

    expect(bootstrapMod.promptAndBootstrap).toHaveBeenCalled();
    expect(heuristics.printKeylessInfo).toHaveBeenCalled();
    expect(loginMod.login).not.toHaveBeenCalled();
    expect(linkMod.link).not.toHaveBeenCalled();
    expect(keylessMod.createAccountlessApp).toHaveBeenCalled();
  });

  test("--keyless takes precedence over an authed user", async () => {
    setup({ email: "user@example.com" });
    mockBootstrapTo(KEYLESS_CTX);
    mockMiddlewareScaffold();

    await init({ keyless: true });

    expect(heuristics.printKeylessInfo).toHaveBeenCalled();
    expect(linkMod.link).not.toHaveBeenCalled();
    expect(pullMod.pull).not.toHaveBeenCalled();
  });

  test("--keyless on a non-keyless framework throws a usage error", async () => {
    setup();
    const nonKeylessCtx: FakeCtx = {
      ...FAKE_CTX,
      existingClerk: false,
      framework: {
        dep: "vue",
        name: "Vue",
        sdk: "@clerk/vue",
        envVar: "VITE_CLERK_PUBLISHABLE_KEY",
        envFile: ".env.local",
      },
      envFile: ".env.local",
    };
    mockBootstrapTo(nonKeylessCtx);

    await expect(init({ keyless: true })).rejects.toThrow(/--keyless is not supported for Vue/);
    expect(keylessMod.createAccountlessApp).not.toHaveBeenCalled();
    expect(linkMod.link).not.toHaveBeenCalled();
  });

  test("--keyless on an existing keyless-capable project uses keyless mode", async () => {
    setup();
    mockExistingProject(KEYLESS_CTX);
    mockMiddlewareScaffold();

    await init({ keyless: true });

    expect(bootstrapMod.promptAndBootstrap).not.toHaveBeenCalled();
    expect(keylessMod.createAccountlessApp).toHaveBeenCalled();
    expect(heuristics.printKeylessInfo).toHaveBeenCalled();
    expect(linkMod.link).not.toHaveBeenCalled();
    expect(loginMod.login).not.toHaveBeenCalled();
  });

  test("bootstrap with keyless framework goes authenticated when already signed in", async () => {
    setup({ email: "user@example.com" });
    mockBootstrapTo({ ...KEYLESS_CTX, existingClerk: true });

    await init({});

    expect(heuristics.isAuthenticated).toHaveBeenCalled();
    expect(heuristics.printKeylessInfo).not.toHaveBeenCalled();
    expect(linkMod.link).toHaveBeenCalled();
  });

  test("-y flag with keyless framework uses authenticated flow when signed in", async () => {
    setup({ email: "user@example.com" });
    mockBootstrapTo({ ...KEYLESS_CTX, existingClerk: true });

    await init({ yes: true });

    expect(heuristics.isAuthenticated).toHaveBeenCalled();
    expect(heuristics.printKeylessInfo).not.toHaveBeenCalled();
  });

  test("-y flag with keyless framework uses authenticated flow when CLERK_PLATFORM_API_KEY is set", async () => {
    setup({ apiKey: true });
    mockBootstrapTo({ ...KEYLESS_CTX, existingClerk: true });

    await init({ yes: true });

    expect(heuristics.isAuthenticated).toHaveBeenCalled();
    expect(heuristics.printKeylessInfo).not.toHaveBeenCalled();
    expect(linkMod.link).toHaveBeenCalled();
  });

  test("-y flag with keyless framework stays keyless when unauthenticated", async () => {
    // `-y` only skips y/n confirmations — it neither forces nor bypasses the
    // keyless default for unauthenticated bootstrap.
    setup();
    mockBootstrapTo(KEYLESS_CTX);
    mockMiddlewareScaffold();

    await init({ yes: true });

    expect(heuristics.isAuthenticated).toHaveBeenCalled();
    expect(heuristics.printKeylessInfo).toHaveBeenCalled();
    expect(loginMod.login).not.toHaveBeenCalled();
    expect(linkMod.link).not.toHaveBeenCalled();
  });

  test("-y --keyless with keyless framework uses keyless mode", async () => {
    setup();
    mockBootstrapTo(KEYLESS_CTX);
    mockMiddlewareScaffold();

    await init({ yes: true, keyless: true });

    expect(heuristics.printKeylessInfo).toHaveBeenCalled();
    expect(linkMod.link).not.toHaveBeenCalled();
    expect(loginMod.login).not.toHaveBeenCalled();
  });

  test("agent mode with keyless framework uses keyless with breadcrumb when unauthenticated", async () => {
    // Agents can't run interactive OAuth, so unauthenticated agent runs default
    // to keyless: the app works immediately and the breadcrumb lets the next
    // `clerk auth login` claim it.
    setup({ isAgent: true, email: null });
    mockExistingProject(KEYLESS_CTX);
    mockMiddlewareScaffold();

    await init({});

    expect(keylessMod.createAccountlessApp).toHaveBeenCalled();
    expect(keylessMod.writeKeylessBreadcrumb).toHaveBeenCalled();
    expect(heuristics.printKeylessInfo).toHaveBeenCalled();
    expect(linkMod.link).not.toHaveBeenCalled();
    expect(pullMod.pull).not.toHaveBeenCalled();
    expect(loginMod.login).not.toHaveBeenCalled();
  });

  test("agent mode with --login while unauthenticated throws a usage error", async () => {
    setup({ isAgent: true, email: null });

    await expect(init({ login: true })).rejects.toThrow(/--login requires an interactive terminal/);
    expect(bootstrapMod.promptAndBootstrap).not.toHaveBeenCalled();
    expect(keylessMod.createAccountlessApp).not.toHaveBeenCalled();
    expect(loginMod.login).not.toHaveBeenCalled();
  });

  test("agent mode with --login while authenticated runs the authenticated flow", async () => {
    setup({ isAgent: true, email: "user@example.com" });
    mockExistingProject(KEYLESS_CTX);
    spyOn(config, "resolveProfile").mockResolvedValue(undefined);
    mockMiddlewareScaffold();

    await init({ login: true });

    expect(heuristics.printKeylessInfo).not.toHaveBeenCalled();
    expect(linkMod.link).toHaveBeenCalled();
    expect(pullMod.pull).toHaveBeenCalled();
  });

  test("agent mode with --keyless uses keyless mode without authentication", async () => {
    setup({ isAgent: true, email: null });
    mockExistingProject(KEYLESS_CTX);
    mockMiddlewareScaffold();

    await init({ keyless: true });

    expect(heuristics.printKeylessInfo).toHaveBeenCalled();
    expect(linkMod.link).not.toHaveBeenCalled();
    expect(loginMod.login).not.toHaveBeenCalled();
    expect(keylessMod.createAccountlessApp).toHaveBeenCalled();
  });

  test("agent mode with keyless framework + authed creates and links a real app", async () => {
    setup({ isAgent: true, email: "user@example.com" });
    mockExistingProject(KEYLESS_CTX);
    // Override potential leakage from earlier tests that spy on resolveProfile
    // with a non-undefined value but don't track those spies for restoration.
    spyOn(config, "resolveProfile").mockResolvedValue(undefined);
    mockMiddlewareScaffold();

    await init({});

    expect(heuristics.printKeylessInfo).not.toHaveBeenCalled();
    expect(linkMod.link).toHaveBeenCalledWith({
      skipIfLinked: true,
      app: undefined,
      cwd: KEYLESS_CTX.cwd,
      createIfMissing: expect.any(String),
    });
    expect(pullMod.pull).toHaveBeenCalledWith({ file: ".env", cwd: KEYLESS_CTX.cwd });
  });

  test("agent mode with keyless framework uses linked profile as a real app target", async () => {
    setup({ isAgent: true, email: "user@example.com" });
    mockExistingProject(KEYLESS_CTX);
    spyOn(config, "resolveProfile").mockResolvedValue({
      profile: { appId: "app_123" },
    } as never);
    mockMiddlewareScaffold();

    await init({});

    expect(heuristics.printKeylessInfo).not.toHaveBeenCalled();
    expect(linkMod.link).not.toHaveBeenCalled();
    expect(pullMod.pull).toHaveBeenCalledWith({ file: ".env", cwd: KEYLESS_CTX.cwd });
  });

  test("agent mode with keyless framework and --app uses real app flow", async () => {
    setup({ isAgent: true, email: "user@example.com" });
    mockExistingProject(KEYLESS_CTX);
    mockMiddlewareScaffold();

    await init({ app: "app_abc" });

    expect(heuristics.printKeylessInfo).not.toHaveBeenCalled();
    expect(linkMod.link).toHaveBeenCalledWith({
      skipIfLinked: true,
      app: "app_abc",
      cwd: KEYLESS_CTX.cwd,
      createIfMissing: expect.any(String),
    });
    expect(pullMod.pull).toHaveBeenCalledWith({ file: ".env", cwd: KEYLESS_CTX.cwd });
  });

  test("agent mode with non-keyless framework and no app target prints manual setup", async () => {
    const { captured } = setup({ isAgent: true, email: "user@example.com" });

    const noKeylessCtx = {
      ...FAKE_CTX,
      existingClerk: false,
      framework: {
        dep: "vue",
        name: "Vue",
        sdk: "@clerk/vue",
        envVar: "VITE_CLERK_PUBLISHABLE_KEY",
        envFile: ".env.local" as const,
      },
      envFile: ".env.local",
    };
    spyOn(context, "gatherContext").mockResolvedValue(noKeylessCtx);
    spyOn(scaffoldMod, "scaffold").mockResolvedValue({
      actions: [{ type: "create", path: "src/main.ts", content: "", description: "" }],
      postInstructions: [],
    });

    await init({});

    expect(linkMod.link).not.toHaveBeenCalled();
    expect(pullMod.pull).not.toHaveBeenCalled();
    expect(loginMod.login).not.toHaveBeenCalled();
    expect(captured.err).toContain("clerk init --app <app_id>");
  });

  test("agent mode with real app target and no auth launches login", async () => {
    setup({ isAgent: true });
    spyOn(context, "gatherContext").mockResolvedValue(FAKE_CTX);

    await init({ app: "app_abc" });

    expect(loginMod.login).toHaveBeenCalledWith({ showNextSteps: false });
    expect(linkMod.link).toHaveBeenCalledWith({
      skipIfLinked: true,
      app: "app_abc",
      cwd: FAKE_CTX.cwd,
      createIfMissing: expect.any(String),
    });
  });

  test("-y flag triggers login when unauthenticated", async () => {
    setup();
    setupBootstrapSuccess();

    await init({ yes: true });

    expect(bootstrapMod.promptAndBootstrap).toHaveBeenCalled();
    expect(heuristics.isAuthenticated).toHaveBeenCalled();
    // `-y` skips y/n confirmations but not authentication.
    expect(loginMod.login).toHaveBeenCalledWith({ showNextSteps: false });
  });

  test("-y flag triggers login for non-keyless frameworks in bootstrap", async () => {
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
    expect(heuristics.isAuthenticated).toHaveBeenCalled();
    expect(loginMod.login).toHaveBeenCalledWith({ showNextSteps: false });
    expect(heuristics.printKeylessInfo).not.toHaveBeenCalled();
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
    // `env pull`.
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
});
