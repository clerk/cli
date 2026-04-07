import { test, expect, describe, afterEach, spyOn } from "bun:test";

// Init's index.test.ts uses spyOn for the inline command-side helpers
// (scaffold, preview, format, scan, heuristics, skills) so that we can assert
// behavior without exercising the real filesystem mutations they perform.
// The collaborator surface (link, env-pull, projectDetector, credentialStore,
// configStore, tokenExchange, environment, etc.) is injected via testRoot.
import * as scaffoldMod from "./scaffold.ts";
import * as previewMod from "./preview.ts";
import * as formatMod from "./format.ts";
import * as scanMod from "./scan.ts";
import * as heuristics from "./heuristics.ts";
import * as skillsMod from "./skills.ts";
import * as linkIfNeededMod from "../link/helpers/link-if-needed.ts";
import * as pullDefaultMod from "../env/helpers/pull-default.ts";
import { init } from "./index.ts";
import { testRoot } from "../../test/lib/test-root.ts";

const FAKE_CTX = {
  cwd: "/tmp/test-project",
  framework: {
    dep: "next",
    name: "Next.js",
    sdk: "@clerk/nextjs",
    envVar: "NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY",
    envFile: ".env" as const,
  },
  typescript: true,
  srcDir: true,
  packageManager: "npm" as const,
  existingClerk: false,
  deps: { next: "15.0.0" },
  envFile: ".env.local",
};

// A scaffold plan with at least one non-skip action so the alreadySetUp
// short-circuit does not fire; tests can then assert on env pull / skills
// invocation behaviour.
const NONEMPTY_PLAN = {
  actions: [{ type: "create" as const, path: "middleware.ts", contents: "" }],
  postInstructions: [],
};

describe("init command", () => {
  let spies: ReturnType<typeof spyOn>[];

  afterEach(() => {
    for (const spy of spies) spy.mockRestore();
  });

  function setup() {
    spies = [
      spyOn(console, "log").mockImplementation(() => {}),
      spyOn(scaffoldMod, "scaffold").mockResolvedValue(NONEMPTY_PLAN as never),
      spyOn(scaffoldMod, "enrichProjectContext").mockResolvedValue(undefined),
      spyOn(previewMod, "previewPlan").mockReturnValue(undefined),
      spyOn(previewMod, "previewAndConfirm").mockResolvedValue(true),
      spyOn(formatMod, "runFormatters").mockResolvedValue(undefined),
      spyOn(scanMod, "detectAuthLibraries").mockReturnValue(undefined),
      spyOn(scanMod, "scanForIssues").mockResolvedValue([]),
      spyOn(heuristics, "printKeylessInfo").mockReturnValue(undefined),
      spyOn(heuristics, "installSdk").mockResolvedValue(undefined),
      spyOn(heuristics, "installDeps").mockResolvedValue(undefined),
      spyOn(heuristics, "writePlan").mockResolvedValue([]),
      spyOn(heuristics, "checkGitDirty").mockResolvedValue(false),
      spyOn(heuristics, "printOutro").mockReturnValue(undefined),
      spyOn(skillsMod, "installSkills").mockResolvedValue(undefined),
      spyOn(linkIfNeededMod, "linkIfNeeded").mockResolvedValue({ linked: true }),
      spyOn(pullDefaultMod, "pullDefault").mockResolvedValue(undefined),
    ];
  }

  test("short-circuits on fully-clean re-run without running env pull or skills", async () => {
    setup();
    // Empty plan with no post-instructions triggers the alreadySetUp short-circuit.
    (
      scaffoldMod.scaffold as unknown as { mockResolvedValue: (v: unknown) => void }
    ).mockResolvedValue({ actions: [], postInstructions: [] });
    const deps = testRoot({
      projectDetector: { gather: async () => FAKE_CTX as never },
      configStore: { resolveProfile: async () => null },
      env: { get: (name: string) => (name === "CLERK_PLATFORM_API_KEY" ? "key" : undefined) },
    });

    await init(deps, { yes: true });

    expect(pullDefaultMod.pullDefault).not.toHaveBeenCalled();
    expect(skillsMod.installSkills).not.toHaveBeenCalled();
  });

  test("links and pulls env when authenticated via API key", async () => {
    setup();
    const deps = testRoot({
      projectDetector: { gather: async () => FAKE_CTX as never },
      configStore: { resolveProfile: async () => null },
      env: { get: (name: string) => (name === "CLERK_PLATFORM_API_KEY" ? "key" : undefined) },
    });

    await init(deps, { yes: true });

    expect(linkIfNeededMod.linkIfNeeded).toHaveBeenCalledWith(deps, { skipIfLinked: true });
    expect(pullDefaultMod.pullDefault).toHaveBeenCalledWith(deps, {
      file: FAKE_CTX.envFile,
    });
    expect(heuristics.printKeylessInfo).not.toHaveBeenCalled();
  });

  test("links and pulls env when authenticated via stored token", async () => {
    setup();
    const deps = testRoot({
      projectDetector: { gather: async () => FAKE_CTX as never },
      credentialStore: { getToken: async () => "valid-token" },
      configStore: { resolveProfile: async () => null },
      tokenExchange: {
        fetchUserInfo: async () => ({ userId: "u_1", email: "test@test.com" }),
      },
      env: { get: () => undefined },
    });

    await init(deps, { yes: true });

    expect(linkIfNeededMod.linkIfNeeded).toHaveBeenCalledWith(deps, { skipIfLinked: true });
    expect(pullDefaultMod.pullDefault).toHaveBeenCalledWith(deps, {
      file: FAKE_CTX.envFile,
    });
    expect(heuristics.printKeylessInfo).not.toHaveBeenCalled();
  });

  test("agent mode early-returns without invoking link/pull/skills", async () => {
    setup();
    const deps = testRoot({
      mode: { isAgent: () => true, isHuman: () => false, getMode: () => "agent" },
    });

    await init(deps, {});

    expect(linkIfNeededMod.linkIfNeeded).not.toHaveBeenCalled();
    expect(pullDefaultMod.pullDefault).not.toHaveBeenCalled();
    expect(skillsMod.installSkills).not.toHaveBeenCalled();
  });

  test("--prompt early-returns the same way as agent mode", async () => {
    setup();
    const deps = testRoot({});

    await init(deps, { prompt: true });

    expect(linkIfNeededMod.linkIfNeeded).not.toHaveBeenCalled();
    expect(pullDefaultMod.pullDefault).not.toHaveBeenCalled();
    expect(skillsMod.installSkills).not.toHaveBeenCalled();
  });

  test("--no-skills suppresses the skills install", async () => {
    setup();
    const deps = testRoot({
      projectDetector: { gather: async () => FAKE_CTX as never },
      configStore: { resolveProfile: async () => null },
      env: { get: (name: string) => (name === "CLERK_PLATFORM_API_KEY" ? "key" : undefined) },
    });

    await init(deps, { yes: true, skills: false });

    expect(skillsMod.installSkills).not.toHaveBeenCalled();
  });
});
