import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { _resetMode, setMode } from "../mode.ts";
import { renderBanner, shouldShowBanner } from "./banner.ts";

const ESC = new RegExp(String.raw`\u001b\[[0-9;]*m`, "g");

describe("renderBanner", () => {
  const base = { version: "3.4.1", environment: "staging", truecolor: true };
  const plainLines = (environment?: string) =>
    renderBanner({ ...base, environment, color: false })
      .trimEnd()
      .split("\n");

  test("places the title, version, and environment on the dot's rows", () => {
    const lines = plainLines("staging");
    expect(lines).toHaveLength(7);
    expect(lines[2]).toEndWith("   Clerk CLI");
    expect(lines[3]).toEndWith("   v3.4.1");
    expect(lines[4]).toEndWith("   staging");
    expect([lines[0], lines[1], lines[5], lines[6]].join("")).not.toMatch(/[a-z]/i);
  });

  test("omits the environment line when none is given", () => {
    const lines = plainLines();
    expect(lines[2]).toEndWith("   Clerk CLI");
    expect(lines[3]).toEndWith("   v3.4.1");
    expect(lines[4]).not.toMatch(/[a-z]/i);
  });

  test("emits no escape codes without color", () => {
    expect(renderBanner({ ...base, color: false })).not.toMatch(ESC);
  });

  test.each([
    { truecolor: true, escape: "\x1b[38;2;108;71;255m" },
    { truecolor: false, escape: "\x1b[38;5;99m" },
  ])("colors only the dot (truecolor=$truecolor)", ({ truecolor, escape }) => {
    const out = renderBanner({ ...base, color: true, truecolor });
    expect(out.split(escape)).toHaveLength(4);
    expect(out.replace(ESC, "")).toBe(renderBanner({ ...base, color: false }));
  });

  test("leaves the arc in the terminal's default foreground", () => {
    const lines = renderBanner({ ...base, color: true }).split("\n");
    expect(lines[0]).not.toMatch(ESC);
    expect(lines[6]).not.toMatch(ESC);
  });
});

describe("shouldShowBanner", () => {
  const isTTY = process.stderr.isTTY;
  const saved = { CI: process.env.CI, CLERK_NO_BANNER: process.env.CLERK_NO_BANNER };

  beforeEach(() => {
    delete process.env.CI;
    delete process.env.CLERK_NO_BANNER;
    setMode("human");
    process.stderr.isTTY = true;
  });

  afterEach(() => {
    _resetMode();
    process.stderr.isTTY = isTTY;
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  test("shows for an interactive human", () => {
    expect(shouldShowBanner()).toBe(true);
  });

  test("hides in agent mode", () => {
    setMode("agent");
    expect(shouldShowBanner()).toBe(false);
  });

  test("hides when stderr is not a terminal", () => {
    process.stderr.isTTY = false;
    expect(shouldShowBanner()).toBe(false);
  });

  test.each(["CI", "CLERK_NO_BANNER"])("hides when %s is set", (key) => {
    process.env[key] = "1";
    expect(shouldShowBanner()).toBe(false);
  });
});
