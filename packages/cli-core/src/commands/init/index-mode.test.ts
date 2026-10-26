import { describe, expect, test } from "bun:test";
import { createProgram } from "../../cli-program.ts";
import { getMode, setMode } from "../../mode.ts";

// A --json starter is read by a program, so it runs in agent mode: sign-in, the app picker,
// relinking, and the starter's own questions all stand down instead of prompting mid-JSON.
describe("clerk init --starter --json", () => {
  async function parse(argv: readonly string[]) {
    const program = createProgram();
    // --accountless makes the action stop right after the hook (an iOS starter rejects it), so
    // a human-mode run never reaches a prompt; only the hook's effect is under test.
    program.exitOverride();
    try {
      await program.parseAsync(["node", "clerk", ...argv, "--accountless"]);
    } catch {
      // expected
    }
    return getMode();
  }

  async function inHumanMode(argv: readonly string[]) {
    const original = getMode();
    try {
      setMode("human");
      return await parse(argv);
    } finally {
      setMode(original);
    }
  }

  test("runs in agent mode", async () => {
    expect(await inHumanMode(["init", "--starter", "--framework", "ios", "--json"])).toBe("agent");
  });

  test.each([
    {
      name: "without --starter",
      argv: ["init", "--json", "--dry-run", "--xcode-project", "/none"],
    },
    { name: "without --json", argv: ["init", "--starter", "--framework", "ios"] },
  ])("leaves the mode alone $name", async ({ argv }) => {
    expect(await inHumanMode(argv)).toBe("human");
  });

  test("an explicit --mode wins", async () => {
    expect(
      await inHumanMode(["--mode", "human", "init", "--starter", "--framework", "ios", "--json"]),
    ).toBe("human");
  });
});
