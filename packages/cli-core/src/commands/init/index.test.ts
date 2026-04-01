import { test, expect, describe, afterEach, spyOn } from "bun:test";

// Pure spyOn approach — Bun's mock.module globally replaces modules for the
// entire test run, which pollutes other test files (link, env/pull, config,
// context, etc.) that import the same modules. spyOn restores cleanly.
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
import { init } from "./index.ts";

describe("init command", () => {
  let spies: ReturnType<typeof spyOn>[];

  afterEach(() => {
    for (const spy of spies) spy.mockRestore();
  });

  function setup(overrides: { email?: string | null } = {}) {
    const email = overrides.email ?? null;

    spies = [
      spyOn(console, "log").mockImplementation(() => {}),
      spyOn(mode, "isAgent").mockReturnValue(false),
      spyOn(config, "resolveProfile").mockResolvedValue(undefined),
      spyOn(frameworkMod, "lookupFramework").mockReturnValue(null),
      spyOn(context, "gatherContext").mockResolvedValue(null),
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
      spyOn(heuristics, "writePlan").mockResolvedValue([]),
      spyOn(heuristics, "checkGitDirty").mockResolvedValue(false),
      spyOn(heuristics, "printOutro").mockReturnValue(undefined),
      spyOn(linkMod, "link").mockResolvedValue(undefined),
      spyOn(pullMod, "pull").mockResolvedValue(undefined),
    ];
  }

  test("defaults to keyless mode when not authenticated", async () => {
    setup({ email: null });

    await init({ yes: true });

    expect(linkMod.link).not.toHaveBeenCalled();
    expect(pullMod.pull).not.toHaveBeenCalled();
    expect(heuristics.printKeylessInfo).toHaveBeenCalled();
  });

  test("links and pulls env when authenticated", async () => {
    setup({ email: "test@test.com" });

    await init({ yes: true });

    expect(linkMod.link).toHaveBeenCalledWith({ skipIfLinked: true });
    expect(pullMod.pull).toHaveBeenCalled();
    expect(heuristics.printKeylessInfo).not.toHaveBeenCalled();
  });
});
