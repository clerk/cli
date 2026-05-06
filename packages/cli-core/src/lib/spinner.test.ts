import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { setPrefixTone } from "./log.ts";
import { intro, outro } from "./spinner.ts";

describe("gutter tone rendering", () => {
  let stderrSpy: ReturnType<typeof spyOn> | undefined;
  const originalMode = process.env.CLERK_MODE;

  afterEach(() => {
    stderrSpy?.mockRestore();
    stderrSpy = undefined;
    if (originalMode === undefined) {
      delete process.env.CLERK_MODE;
    } else {
      process.env.CLERK_MODE = originalMode;
    }
  });

  test("uses active and error tones for intro and outro rails", () => {
    process.env.CLERK_MODE = "human";
    stderrSpy = spyOn(process.stderr, "write").mockImplementation(() => true);

    intro("clerk deploy", { tone: "active" });
    setPrefixTone("error");
    outro("Paused");

    const output = stderrSpy.mock.calls.map((call: unknown[]) => String(call[0])).join("");
    expect(output).toContain("\x1b[36m┌");
    expect(output).toContain("\x1b[33m│");
    expect(output).toContain("\x1b[33m└");
  });
});
