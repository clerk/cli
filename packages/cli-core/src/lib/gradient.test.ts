import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { bold } from "./color.ts";
import { animateHeader, hslToRgb, rgbTo256, shineText } from "./gradient.ts";
import { useCaptureLog } from "../test/lib/stubs.ts";

const count = (haystack: string, needle: string) => haystack.split(needle).length - 1;

function firstRgb(s: string): [number, number, number] {
  const m = s.match(/38;2;(\d+);(\d+);(\d+)/);
  if (!m) throw new Error("no truecolor escape found");
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

describe("hslToRgb", () => {
  test.each([
    { hue: 0, rgb: [255, 0, 0], name: "red" },
    { hue: 120, rgb: [0, 255, 0], name: "green" },
    { hue: 240, rgb: [0, 0, 255], name: "blue" },
  ])("hue $hue maps to $name", ({ hue, rgb }) => {
    expect(hslToRgb(hue, 1, 0.5)).toEqual(rgb as [number, number, number]);
  });

  test("clamps channels to the 0-255 byte range", () => {
    const [r, g, b] = hslToRgb(300, 1, 0.6);
    for (const channel of [r, g, b]) {
      expect(channel).toBeGreaterThanOrEqual(0);
      expect(channel).toBeLessThanOrEqual(255);
    }
  });
});

describe("rgbTo256", () => {
  test.each([
    { rgb: [0, 0, 0], idx: 16, name: "black to cube origin" },
    { rgb: [255, 255, 255], idx: 231, name: "white to cube apex" },
    { rgb: [255, 0, 0], idx: 196, name: "red to cube red" },
  ])("$name", ({ rgb, idx }) => {
    expect(rgbTo256(rgb[0]!, rgb[1]!, rgb[2]!)).toBe(idx);
  });
});

describe("shineText", () => {
  test("emits one truecolor escape per visible character and resets fg at the end", () => {
    const out = shineText("Hi", { truecolor: true });
    expect(count(out, "\x1b[38;2;")).toBe(2);
    expect(out.endsWith("\x1b[39m")).toBe(true);
    expect(out).toContain("H");
    expect(out).toContain("i");
  });

  test("flat base color (no center) paints every character the same color", () => {
    const out = shineText("abcd", { truecolor: true });
    const triples = [...out.matchAll(/38;2;(\d+;\d+;\d+)/g)].map((m) => m[1]);
    expect(triples).toHaveLength(4);
    expect(new Set(triples).size).toBe(1);
  });

  test("the reflex brightens characters near its center", () => {
    const flat = firstRgb(shineText("Next", { truecolor: true }));
    const lit = firstRgb(shineText("Next", { truecolor: true, center: 0 }));
    const sum = (c: [number, number, number]) => c[0] + c[1] + c[2];
    expect(sum(lit)).toBeGreaterThan(sum(flat));
  });

  test("the reflex is local, a far character is unaffected", () => {
    const flatFirst = firstRgb(shineText("Next", { truecolor: true }));
    const litLastFirst = firstRgb(shineText("Next", { truecolor: true, center: 1 }));
    expect(litLastFirst).toEqual(flatFirst);
  });

  test("uses the 256-color palette when truecolor is unavailable", () => {
    const out = shineText("Hi", { truecolor: false });
    expect(out).toContain("\x1b[38;5;");
    expect(out).not.toContain("\x1b[38;2;");
  });

  test("leaves spaces uncolored so the gutter stays clean", () => {
    const out = shineText("a b", { truecolor: true });
    expect(count(out, "\x1b[38;2;")).toBe(2);
    expect(out).toContain(" ");
  });

  test("a single character renders without a divide-by-zero blowup", () => {
    const out = shineText("X", { truecolor: true, center: 0 });
    expect(count(out, "\x1b[38;2;")).toBe(1);
    expect(out).toContain("X");
  });

  test.each([
    { label: "", name: "empty string" },
    { label: "   ", name: "whitespace only" },
  ])("$name emits no bare foreground reset that would clobber a surrounding color", ({ label }) => {
    const out = shineText(label, { truecolor: true });
    expect(out).toBe(label);
    expect(out).not.toContain("\x1b[39m");
  });
});

describe("animateHeader (non-interactive)", () => {
  const captured = useCaptureLog();

  test("emits the fallback-styled header once with no in-place redraw escapes", async () => {
    await animateHeader({ prefix: "", label: "Next steps", fallback: bold });
    expect(captured.stderr).toHaveLength(1);
    const line = captured.stderr[0]!;
    expect(line).toBe(`${bold("Next steps")}\n`);
    expect(line).not.toContain("\r");
    expect(line).not.toContain("\x1b[?25l");
  });

  test("preserves a caller-supplied gutter prefix", async () => {
    await animateHeader({ prefix: "│  ", label: "Next steps", fallback: bold });
    expect(captured.stderr[0]).toBe(`│  ${bold("Next steps")}\n`);
  });

  test("prints the header and body together in one write", async () => {
    await animateHeader({
      prefix: "",
      label: "Next steps",
      fallback: bold,
      body: "   → a\n   → b\n",
    });
    expect(captured.stderr).toHaveLength(1);
    expect(captured.stderr[0]).toBe(`${bold("Next steps")}\n   → a\n   → b\n`);
  });
});

describe("animateHeader (interactive gating)", () => {
  const captured = useCaptureLog();
  const ENV_KEYS = ["CI", "NO_COLOR", "FORCE_COLOR", "COLORTERM"] as const;
  let savedTTY: boolean | undefined;
  let savedEnv: Record<string, string | undefined>;

  beforeEach(() => {
    savedTTY = process.stderr.isTTY;
    savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
    Object.defineProperty(process.stderr, "isTTY", { value: true, configurable: true });
    for (const k of ENV_KEYS) delete process.env[k];
    process.env.COLORTERM = "truecolor";
  });
  afterEach(() => {
    Object.defineProperty(process.stderr, "isTTY", { value: savedTTY, configurable: true });
    for (const k of ENV_KEYS) {
      if (savedEnv[k] == null) delete process.env[k];
      else process.env[k] = savedEnv[k];
    }
  });

  const run = () =>
    animateHeader({ prefix: "", label: "Hi", fallback: bold, frames: 2, intervalMs: 1 });

  test("animates on an interactive TTY and balances cursor hide/restore", async () => {
    await run();
    expect(captured.err).toContain("\r");
    expect(captured.err).toContain("\x1b[?25l");
    expect(captured.err).toContain("\x1b[?25h");
  });

  test("prints the body before sweeping the header so it never looks hung", async () => {
    await animateHeader({
      prefix: "",
      label: "Hi",
      fallback: bold,
      body: "   → a\n   → b\n",
      frames: 2,
      intervalMs: 1,
    });
    const out = captured.err;
    expect(out).toContain("→ a");
    expect(out).toContain("→ b");
    // The body is written before the first in-place header redraw (\r).
    expect(out.indexOf("→ a")).toBeLessThan(out.indexOf("\r"));
    // The cursor steps up to the header (1 + 2 body newlines) and back down.
    expect(out).toContain("\x1b[3A");
    expect(out).toContain("\x1b[3B");
  });

  test("NO_COLOR disables the animation (plain fallback, no redraw)", async () => {
    process.env.NO_COLOR = "1";
    await run();
    expect(captured.err).not.toContain("\r");
    expect(captured.err).not.toContain("\x1b[?25l");
  });

  test.each([
    { force: "0", name: "FORCE_COLOR=0" },
    { force: "false", name: "FORCE_COLOR=false" },
    { force: "", name: "FORCE_COLOR=''" },
  ])("$name does not override NO_COLOR", async ({ force }) => {
    process.env.NO_COLOR = "1";
    process.env.FORCE_COLOR = force;
    await run();
    expect(captured.err).not.toContain("\r");
  });

  test("FORCE_COLOR=1 forces the animation even with NO_COLOR set", async () => {
    process.env.NO_COLOR = "1";
    process.env.FORCE_COLOR = "1";
    await run();
    expect(captured.err).toContain("\r");
  });

  test("falls back to a plain write when the block is taller than the terminal", async () => {
    const savedRows = process.stderr.rows;
    try {
      Object.defineProperty(process.stderr, "rows", { value: 5, configurable: true });
      await animateHeader({
        prefix: "",
        label: "Hi",
        fallback: bold,
        // 5 newlines → rowsBelow = 6, which exceeds rows = 5
        body: "a\nb\nc\nd\ne\n",
        frames: 2,
        intervalMs: 1,
      });
      expect(captured.err).not.toContain("\r");
      expect(captured.err).not.toContain("\x1b[?25l");
      expect(captured.err).toContain("a");
    } finally {
      Object.defineProperty(process.stderr, "rows", { value: savedRows, configurable: true });
    }
  });
});
