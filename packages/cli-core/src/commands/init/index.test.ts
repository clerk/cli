import { test, expect, describe, afterEach, spyOn } from "bun:test";

// Use spyOn exclusively — Bun's mock.module pollutes the global module registry
// and breaks other test files that import the same modules.
import * as linkMod from "../link/index.ts";
import * as pullMod from "../env/pull.ts";
import * as context from "./context.ts";
import * as scaffoldMod from "./scaffold.ts";
import * as scanMod from "./scan.ts";
import * as heuristics from "./heuristics.ts";
import * as mode from "../../mode.ts";
import * as framework from "../../lib/framework.ts";
import * as config from "../../lib/config.ts";
import { init } from "./index.ts";

describe("init command", () => {
  let spies: ReturnType<typeof spyOn>[];

  afterEach(() => {
    for (const spy of spies) spy.mockRestore();
  });

  function setupMocks(overrides: { email?: string | null } = {}) {
    const email = overrides.email ?? null;

    spies = [
      spyOn(console, "log").mockImplementation(() => {}),
      spyOn(mode, "isAgent").mockReturnValue(false),
      spyOn(framework, "lookupFramework").mockReturnValue(undefined),
      spyOn(config, "resolveProfile").mockResolvedValue(undefined),
      spyOn(context, "gatherContext").mockResolvedValue(null),
      spyOn(scaffoldMod, "scaffold").mockResolvedValue({ actions: [], postInstructions: [] }),
      spyOn(scaffoldMod, "enrichProjectContext").mockResolvedValue(undefined),
      spyOn(scanMod, "detectAuthLibraries").mockReturnValue(undefined),
      spyOn(scanMod, "scanForIssues").mockResolvedValue([]),
      spyOn(heuristics, "installSdk").mockResolvedValue(undefined),
      spyOn(heuristics, "writePlan").mockResolvedValue([]),
      spyOn(heuristics, "checkGitDirty").mockResolvedValue(false),
      spyOn(heuristics, "printOutro").mockReturnValue(undefined),
      spyOn(heuristics, "printKeylessInfo").mockReturnValue(undefined),
      spyOn(heuristics, "getAuthenticatedEmail").mockResolvedValue(email),
      spyOn(linkMod, "link").mockResolvedValue(undefined),
      spyOn(pullMod, "pull").mockResolvedValue(undefined),
    ];
  }

  test("defaults to keyless mode when not authenticated", async () => {
    setupMocks({ email: null });

    await init({ yes: true });

    expect(linkMod.link).not.toHaveBeenCalled();
    expect(pullMod.pull).not.toHaveBeenCalled();
    expect(heuristics.printKeylessInfo).toHaveBeenCalled();
  });

  test("links and pulls env when authenticated", async () => {
    setupMocks({ email: "test@test.com" });

    await init({ yes: true });

    expect(linkMod.link).toHaveBeenCalledWith({ skipIfLinked: true });
    expect(pullMod.pull).toHaveBeenCalled();
    expect(heuristics.printKeylessInfo).not.toHaveBeenCalled();
  });
});
