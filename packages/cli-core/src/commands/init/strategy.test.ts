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
  keylessTargetMod,
} from "../../test/lib/init-harness.ts";
import * as promptsMod from "../../lib/prompts.ts";
import { init } from "./index.ts";

const EXISTING_BREADCRUMB = { claimToken: "tok_existing", createdAt: "2024-01-01T00:00:00.000Z" };

describe("init strategy", () => {
  const { setup, setupBootstrapSuccess, track } = useInitHarness();
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
      /--template applies to accountless applications/,
    );
    expect(bootstrapMod.promptAndBootstrap).not.toHaveBeenCalled();
  });

  test("--accountless with --login throws a usage error before bootstrapping", async () => {
    setup();

    await expect(init({ accountless: true, login: true })).rejects.toThrow(
      /--accountless and --login cannot be combined/,
    );
    expect(bootstrapMod.promptAndBootstrap).not.toHaveBeenCalled();
    expect(keylessMod.createAccountlessApp).not.toHaveBeenCalled();
    expect(loginMod.login).not.toHaveBeenCalled();
  });

  test("--accountless with --app throws a usage error before bootstrapping", async () => {
    setup();

    await expect(init({ accountless: true, app: "app_abc" })).rejects.toThrow(
      /--accountless cannot be combined with --app/,
    );
    expect(bootstrapMod.promptAndBootstrap).not.toHaveBeenCalled();
    expect(keylessMod.createAccountlessApp).not.toHaveBeenCalled();
    expect(linkMod.link).not.toHaveBeenCalled();
  });

  test("--accountless on a supported framework uses accountless mode without logging in", async () => {
    setup();
    mockBootstrapTo(KEYLESS_CTX);
    mockMiddlewareScaffold();

    await init({ accountless: true });

    expect(bootstrapMod.promptAndBootstrap).toHaveBeenCalled();
    expect(heuristics.printKeylessInfo).toHaveBeenCalled();
    expect(loginMod.login).not.toHaveBeenCalled();
    expect(linkMod.link).not.toHaveBeenCalled();
    expect(keylessMod.createAccountlessApp).toHaveBeenCalled();
  });

  test("deprecated --keyless behaves as --accountless and warns", async () => {
    const { captured } = setup();
    mockBootstrapTo(KEYLESS_CTX);
    mockMiddlewareScaffold();

    await init({ keyless: true });

    expect(keylessMod.createAccountlessApp).toHaveBeenCalled();
    expect(loginMod.login).not.toHaveBeenCalled();
    expect(captured.err).toContain("`--keyless` is deprecated. Use `--accountless` instead.");
  });

  test("deprecated --keyless with --login throws the same usage error as --accountless", async () => {
    setup();

    await expect(init({ keyless: true, login: true })).rejects.toThrow(
      /--accountless and --login cannot be combined/,
    );
    expect(keylessMod.createAccountlessApp).not.toHaveBeenCalled();
    expect(loginMod.login).not.toHaveBeenCalled();
  });

  test("--accountless takes precedence over an authed user", async () => {
    setup({ email: "user@example.com" });
    mockBootstrapTo(KEYLESS_CTX);
    mockMiddlewareScaffold();

    await init({ accountless: true });

    expect(heuristics.printKeylessInfo).toHaveBeenCalled();
    expect(linkMod.link).not.toHaveBeenCalled();
    expect(pullMod.pull).not.toHaveBeenCalled();
  });

  test("--accountless on an unsupported framework throws a usage error", async () => {
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

    await expect(init({ accountless: true })).rejects.toThrow(
      /--accountless is not supported for Vue/,
    );
    expect(keylessMod.createAccountlessApp).not.toHaveBeenCalled();
    expect(linkMod.link).not.toHaveBeenCalled();
  });

  test("--accountless on an existing supported project uses accountless mode", async () => {
    setup();
    mockExistingProject(KEYLESS_CTX);
    mockMiddlewareScaffold();

    await init({ accountless: true });

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

  test("-y --accountless with a supported framework uses accountless mode", async () => {
    setup();
    mockBootstrapTo(KEYLESS_CTX);
    mockMiddlewareScaffold();

    await init({ yes: true, accountless: true });

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

  test("agent mode with --accountless uses accountless mode without authentication", async () => {
    setup({ isAgent: true, email: null });
    mockExistingProject(KEYLESS_CTX);
    mockMiddlewareScaffold();

    await init({ accountless: true });

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

  describe("keeping an existing unclaimed keyless app (defect: re-run minted a second app)", () => {
    test("agent mode keeps an existing unclaimed keyless app without prompting or minting a new one", async () => {
      setup({ isAgent: true, email: null });
      mockExistingProject(KEYLESS_CTX);
      mockMiddlewareScaffold();
      const breadcrumbSpy = spyOn(keylessMod, "readKeylessBreadcrumb").mockResolvedValue(
        EXISTING_BREADCRUMB,
      );
      const confirmSpy = spyOn(promptsMod, "confirm");
      const printExistingSpy = spyOn(heuristics, "printExistingKeylessInfo").mockReturnValue(
        undefined,
      );
      track(breadcrumbSpy);
      track(confirmSpy);
      track(printExistingSpy);

      await init({});

      expect(confirmSpy).not.toHaveBeenCalled();
      expect(keylessMod.createAccountlessApp).not.toHaveBeenCalled();
      expect(keylessMod.writeKeylessBreadcrumb).not.toHaveBeenCalled();
      expect(printExistingSpy).toHaveBeenCalledWith(KEYLESS_CTX.envFile);
    });

    test("-y keeps an existing unclaimed keyless app without prompting (does not force a fresh one)", async () => {
      setup({ email: null });
      mockExistingProject(KEYLESS_CTX);
      mockMiddlewareScaffold();
      const breadcrumbSpy = spyOn(keylessMod, "readKeylessBreadcrumb").mockResolvedValue(
        EXISTING_BREADCRUMB,
      );
      const confirmSpy = spyOn(promptsMod, "confirm");
      const printExistingSpy = spyOn(heuristics, "printExistingKeylessInfo").mockReturnValue(
        undefined,
      );
      track(breadcrumbSpy);
      track(confirmSpy);
      track(printExistingSpy);

      await init({ keyless: true, yes: true });

      expect(confirmSpy).not.toHaveBeenCalled();
      expect(keylessMod.createAccountlessApp).not.toHaveBeenCalled();
    });

    test("human mode prompts before replacing, defaulting to keep when declined", async () => {
      setup({ email: null });
      mockExistingProject(KEYLESS_CTX);
      mockMiddlewareScaffold();
      const breadcrumbSpy = spyOn(keylessMod, "readKeylessBreadcrumb").mockResolvedValue(
        EXISTING_BREADCRUMB,
      );
      const confirmSpy = spyOn(promptsMod, "confirm").mockResolvedValue(false);
      const printExistingSpy = spyOn(heuristics, "printExistingKeylessInfo").mockReturnValue(
        undefined,
      );
      track(breadcrumbSpy);
      track(confirmSpy);
      track(printExistingSpy);

      await init({ keyless: true });

      expect(confirmSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          message: expect.stringContaining("already has an unclaimed accountless application"),
          default: false,
        }),
      );
      expect(keylessMod.createAccountlessApp).not.toHaveBeenCalled();
      expect(printExistingSpy).toHaveBeenCalledWith(KEYLESS_CTX.envFile);
    });

    test("an app the SDK minted for itself counts as existing too — no silent replacement", async () => {
      setup({ isAgent: true, email: null });
      mockExistingProject(KEYLESS_CTX);
      mockMiddlewareScaffold();
      // No CLI breadcrumb — the app came from running the dev server, so the
      // only trace is the SDK's own .clerk/.tmp/keyless.json.
      const breadcrumbSpy = spyOn(keylessMod, "readKeylessBreadcrumb").mockResolvedValue(undefined);
      const sdkAppSpy = spyOn(keylessTargetMod, "readSdkKeylessApp").mockResolvedValue({
        secretKey: "sk_test_sdkapp",
        publishableKey: "pk_test_sdkapp",
      });
      const confirmSpy = spyOn(promptsMod, "confirm");
      const printExistingSpy = spyOn(heuristics, "printExistingKeylessInfo").mockReturnValue(
        undefined,
      );
      track(breadcrumbSpy);
      track(sdkAppSpy);
      track(confirmSpy);
      track(printExistingSpy);

      await init({});

      expect(confirmSpy).not.toHaveBeenCalled();
      expect(keylessMod.createAccountlessApp).not.toHaveBeenCalled();
      expect(printExistingSpy).toHaveBeenCalledWith(KEYLESS_CTX.envFile);
    });

    test("human mode names the SDK file when prompting to replace an SDK-minted app", async () => {
      setup({ email: null });
      mockExistingProject(KEYLESS_CTX);
      mockMiddlewareScaffold();
      const breadcrumbSpy = spyOn(keylessMod, "readKeylessBreadcrumb").mockResolvedValue(undefined);
      const sdkAppSpy = spyOn(keylessTargetMod, "readSdkKeylessApp").mockResolvedValue({
        secretKey: "sk_test_sdkapp",
      });
      const confirmSpy = spyOn(promptsMod, "confirm").mockResolvedValue(false);
      const printExistingSpy = spyOn(heuristics, "printExistingKeylessInfo").mockReturnValue(
        undefined,
      );
      track(breadcrumbSpy);
      track(sdkAppSpy);
      track(confirmSpy);
      track(printExistingSpy);

      await init({ keyless: true });

      expect(confirmSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          message: expect.stringContaining(".clerk/.tmp/keyless.json"),
          default: false,
        }),
      );
      expect(keylessMod.createAccountlessApp).not.toHaveBeenCalled();
    });

    test("human mode mints a fresh app when the user confirms replacement", async () => {
      setup({ email: null });
      mockExistingProject(KEYLESS_CTX);
      mockMiddlewareScaffold();
      const breadcrumbSpy = spyOn(keylessMod, "readKeylessBreadcrumb").mockResolvedValue(
        EXISTING_BREADCRUMB,
      );
      const confirmSpy = spyOn(promptsMod, "confirm").mockResolvedValue(true);
      track(breadcrumbSpy);
      track(confirmSpy);

      await init({ keyless: true });

      expect(keylessMod.createAccountlessApp).toHaveBeenCalled();
      expect(keylessMod.writeKeylessBreadcrumb).toHaveBeenCalled();
    });

    test("--fresh mints a new app without prompting or checking for an existing one, even in agent mode", async () => {
      setup({ isAgent: true, email: null });
      mockExistingProject(KEYLESS_CTX);
      mockMiddlewareScaffold();
      const breadcrumbSpy = spyOn(keylessMod, "readKeylessBreadcrumb");
      const confirmSpy = spyOn(promptsMod, "confirm");
      track(breadcrumbSpy);
      track(confirmSpy);

      await init({ fresh: true });

      expect(breadcrumbSpy).not.toHaveBeenCalled();
      expect(confirmSpy).not.toHaveBeenCalled();
      expect(keylessMod.createAccountlessApp).toHaveBeenCalled();
    });

    test("--fresh with --login throws a usage error before bootstrapping", async () => {
      setup();

      await expect(init({ fresh: true, login: true })).rejects.toThrow(
        /--fresh applies to accountless applications/,
      );
      expect(bootstrapMod.promptAndBootstrap).not.toHaveBeenCalled();
    });

    test("no existing breadcrumb mints an app normally without prompting", async () => {
      setup({ isAgent: true, email: null });
      mockExistingProject(KEYLESS_CTX);
      mockMiddlewareScaffold();
      const breadcrumbSpy = spyOn(keylessMod, "readKeylessBreadcrumb").mockResolvedValue(undefined);
      const confirmSpy = spyOn(promptsMod, "confirm");
      track(breadcrumbSpy);
      track(confirmSpy);

      await init({});

      expect(confirmSpy).not.toHaveBeenCalled();
      expect(keylessMod.createAccountlessApp).toHaveBeenCalled();
    });
  });

  describe("--template / --fresh silently dropped when the strategy isn't keyless (defect)", () => {
    test("--template with CLERK_PLATFORM_API_KEY set errors instead of silently dropping the template", async () => {
      setup({ apiKey: true });
      mockExistingProject(KEYLESS_CTX);

      await expect(init({ template: "b2b-saas", yes: true })).rejects.toThrow(
        /--template only applies to accountless applications/,
      );
      expect(keylessMod.createAccountlessApp).not.toHaveBeenCalled();
    });

    test("--fresh with CLERK_PLATFORM_API_KEY set errors instead of silently doing nothing", async () => {
      setup({ apiKey: true });
      mockExistingProject(KEYLESS_CTX);

      await expect(init({ fresh: true, yes: true })).rejects.toThrow(
        /--fresh only applies to accountless applications/,
      );
    });

    test("--template with --app errors (a real app target always forces the authenticated flow)", async () => {
      setup({ email: "user@example.com" });
      spyOn(context, "gatherContext").mockResolvedValue(KEYLESS_CTX);

      await expect(init({ template: "b2b-saas", app: "app_abc", yes: true })).rejects.toThrow(
        /--template only applies to accountless applications/,
      );
    });

    test("--template on a non-keyless framework in agent mode names the missing keyless support", async () => {
      setup({ isAgent: true, email: "user@example.com" });
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
      spyOn(context, "gatherContext").mockResolvedValue(nonKeylessCtx);

      await expect(init({ template: "b2b-saas" })).rejects.toThrow(
        /does not support accountless setup/,
      );
    });

    test("--template on a non-keyless framework in human mode names the missing keyless support", async () => {
      setup({ email: null });
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
      spyOn(context, "gatherContext").mockResolvedValue(nonKeylessCtx);

      // Human mode resolves an unsupported framework to the authenticated
      // flow, so the guard must not suggest --accountless here.
      await expect(init({ template: "b2b-saas" })).rejects.toThrow(
        /does not support accountless setup/,
      );
      expect(loginMod.login).not.toHaveBeenCalled();
    });

    test("--template on a keyless-resolved run is still forwarded normally", async () => {
      setup();
      mockBootstrapTo(KEYLESS_CTX);
      mockMiddlewareScaffold();

      await init({ template: "b2b-saas" });

      expect(keylessMod.createAccountlessApp).toHaveBeenCalledWith(
        KEYLESS_CTX.framework.dep,
        "b2b-saas",
      );
    });
  });

  describe("agent mode never trusts stored-credential presence over an interactive login hang (defect)", () => {
    test("falls back to keyless when the stored credential's presence check would say yes but validation fails", async () => {
      // Regression test for the hang: a broken/expired stored session still
      // makes hasAccountCredentials() (presence) report true, but agent mode
      // has no interactive fallback if that lies — it must validate before
      // trusting it, not just check whether *something* is stored.
      setup({ isAgent: true, email: null });
      spyOn(heuristics, "isAuthenticated").mockResolvedValue(true);
      mockExistingProject(KEYLESS_CTX);
      mockMiddlewareScaffold();

      await init({});

      expect(heuristics.isAuthenticated).not.toHaveBeenCalled();
      expect(keylessMod.createAccountlessApp).toHaveBeenCalled();
      expect(loginMod.login).not.toHaveBeenCalled();
    });

    test("--login validates the credential instead of trusting presence, still erroring on a stale session", async () => {
      setup({ isAgent: true, email: null });
      spyOn(heuristics, "isAuthenticated").mockResolvedValue(true);

      await expect(init({ login: true })).rejects.toThrow(
        /--login requires an interactive terminal/,
      );
      expect(loginMod.login).not.toHaveBeenCalled();
      expect(bootstrapMod.promptAndBootstrap).not.toHaveBeenCalled();
    });

    test("a real CLERK_PLATFORM_API_KEY is trusted outright, without needing to validate a stored session", async () => {
      process.env.CLERK_PLATFORM_API_KEY = "test_key";
      try {
        setup({ isAgent: true, email: null });
        mockExistingProject(KEYLESS_CTX);
        spyOn(config, "resolveProfile").mockResolvedValue(undefined);
        mockMiddlewareScaffold();

        await init({});

        expect(linkMod.link).toHaveBeenCalled();
        expect(keylessMod.createAccountlessApp).not.toHaveBeenCalled();
      } finally {
        delete process.env.CLERK_PLATFORM_API_KEY;
      }
    });
  });
});
