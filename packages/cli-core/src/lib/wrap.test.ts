import { describe, expect, test } from "bun:test";
import { cyan } from "./color.ts";
import { visibleWidth, wrap } from "./wrap.ts";

describe("wrap", () => {
  test("keeps a short line as one line", () => {
    expect(wrap("Short enough.")).toEqual(["Short enough."]);
  });

  test("breaks on spaces so no line exceeds the width", () => {
    const text = "one two three four five six seven eight nine ten eleven twelve";
    const lines = wrap(text, { width: 20 });
    expect(lines.every((line) => line.length <= 20)).toBe(true);
    expect(lines.join(" ")).toBe(text);
  });

  test("gives a bullet a hanging indent on continuation lines", () => {
    const lines = wrap("  - Add them at your DNS provider if you haven't already.", { width: 30 });
    expect(lines[0]).toBe("  - Add them at your DNS");
    expect(
      lines.slice(1).every((line) => line.startsWith("    ") && !line.startsWith("     ")),
    ).toBe(true);
  });

  test("uses an explicit hang for a label prefix", () => {
    const lines = wrap("NOTE  DNS records usually propagate within minutes.", {
      width: 32,
      hang: 6,
    });
    expect(lines[0]).toBe("NOTE  DNS records usually");
    expect(lines[1]).toBe("      propagate within minutes.");
  });

  test("measures width without color codes", () => {
    expect(visibleWidth(cyan("example.com"))).toBe("example.com".length);
    const lines = wrap(
      `Clerk will use these subdomains for ${cyan("example.com")}. More words here.`,
      {
        width: 50,
      },
    );
    expect(lines.every((line) => visibleWidth(line) <= 50)).toBe(true);
    expect(lines[0]).toContain(cyan("example.com"));
  });

  test("never splits a token wider than the width", () => {
    const url = "https://dashboard.clerk.com/apps/app_1/instances/ins_prod/domains";
    const lines = wrap(`See ${url} for details.`, { width: 20 });
    expect(lines).toContain(url);
  });
});
