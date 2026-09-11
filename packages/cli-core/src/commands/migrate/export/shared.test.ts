import { beforeEach, describe, expect, mock, test } from "bun:test";

const mockText = mock();
mock.module("../../../lib/prompts.ts", () => ({
  text: (...args: unknown[]) => mockText(...args),
}));

let human = true;
mock.module("../../../mode.ts", () => ({
  isHuman: () => human,
  isAgent: () => !human,
  getMode: () => (human ? "human" : "agent"),
  setMode: () => {},
}));

const { defaultOutputPath, outputStamp, resolveOutputPath } = await import("./shared.ts");

beforeEach(() => {
  human = true;
  mockText.mockReset();
});

describe("outputStamp", () => {
  // Local time, and no seconds: this ends up in a filename someone reads off
  // the screen and types back.
  test("stamps to the minute", () => {
    expect(outputStamp(new Date(2026, 7, 17, 14, 32, 59))).toBe("20260817-1432");
  });

  test("pads single-digit months, days, hours and minutes", () => {
    expect(outputStamp(new Date(2026, 0, 3, 9, 5, 0))).toBe("20260103-0905");
  });
});

describe("defaultOutputPath", () => {
  test("names the platform and the stamp, under exports/", () => {
    expect(defaultOutputPath("clerk", new Date(2026, 7, 17, 14, 32))).toBe(
      "exports/clerk-export-20260817-1432.json",
    );
  });

  // Two exports of the same platform an hour apart must not collide.
  test("gives two runs different names", () => {
    expect(defaultOutputPath("auth0", new Date(2026, 7, 17, 14, 32))).not.toBe(
      defaultOutputPath("auth0", new Date(2026, 7, 17, 15, 32)),
    );
  });
});

describe("resolveOutputPath", () => {
  test("--output is an answer already given", async () => {
    expect(await resolveOutputPath("clerk", "somewhere/mine.json")).toBe("somewhere/mine.json");
    expect(mockText).not.toHaveBeenCalled();
  });

  // One prompt, not a confirm plus a path question: the proposal is prefilled,
  // so enter accepts it and typing replaces it.
  test("prefills the proposed path so enter accepts it", async () => {
    mockText.mockImplementation(async (config: { default: string }) => config.default);

    const chosen = await resolveOutputPath("clerk");

    expect(chosen).toMatch(/^exports\/clerk-export-\d{8}-\d{4}\.json$/);
    expect(mockText).toHaveBeenCalledTimes(1);
    expect(mockText.mock.calls[0]?.[0]).toMatchObject({ message: "Save the export to:" });
  });

  test("takes a path typed over the proposal, trimmed", async () => {
    mockText.mockResolvedValue("  ../elsewhere/users.json  ");

    expect(await resolveOutputPath("firebase")).toBe("../elsewhere/users.json");
  });

  test("agent mode takes the proposed path without asking", async () => {
    human = false;

    expect(await resolveOutputPath("supabase")).toMatch(
      /^exports\/supabase-export-\d{8}-\d{4}\.json$/,
    );
    expect(mockText).not.toHaveBeenCalled();
  });
});
