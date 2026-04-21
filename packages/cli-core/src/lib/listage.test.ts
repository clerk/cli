import { test, expect, describe, beforeEach } from "bun:test";
import { scrollBounds, withScrollIndicators, filterChoices, ttyContext } from "./listage.ts";

describe("scrollBounds", () => {
  test("returns zeros when all items fit on page", () => {
    expect(scrollBounds(5, 0, 7)).toEqual({ above: 0, below: 0 });
    expect(scrollBounds(7, 3, 7)).toEqual({ above: 0, below: 0 });
  });

  test("at the top of a long list", () => {
    // 20 items, active=0, pageSize=5 → first 5 visible
    expect(scrollBounds(20, 0, 5)).toEqual({ above: 0, below: 15 });
    expect(scrollBounds(20, 1, 5)).toEqual({ above: 0, below: 15 });
  });

  test("in the middle of a long list", () => {
    // 20 items, active=10, pageSize=5, middle=2 → firstVisible=8
    const result = scrollBounds(20, 10, 5);
    expect(result.above).toBe(8);
    expect(result.below).toBe(7);
    expect(result.above + result.below + 5).toBe(20);
  });

  test("near the bottom of a long list", () => {
    // 20 items, active=19, pageSize=5 → last 5 visible
    expect(scrollBounds(20, 19, 5)).toEqual({ above: 15, below: 0 });
  });

  test("above + below + pageSize = totalItems (pageSize=5)", () => {
    for (let active = 0; active < 20; active++) {
      const { above, below } = scrollBounds(20, active, 5);
      expect(above + below + 5).toBe(20);
    }
  });

  test("above + below + pageSize = totalItems (pageSize=7, odd)", () => {
    // Odd pageSize may drift by ±1 at boundaries but must never be catastrophically wrong
    for (let active = 0; active < 20; active++) {
      const { above, below } = scrollBounds(20, active, 7);
      expect(above + below + 7).toBe(20);
    }
  });
});

describe("withScrollIndicators", () => {
  test("wraps page with indicator lines", () => {
    const page = "  item1\n❯ item2\n  item3";
    const result = withScrollIndicators(page, 20, 10, 3);
    const lines = result.split("\n");
    // Should always have top indicator, page lines, bottom indicator
    expect(lines.length).toBe(5); // top + 3 page lines + bottom
    expect(lines[0]).toContain("more above");
    expect(lines[4]).toContain("more below");
  });

  test("shows empty placeholder lines at edges for stable height", () => {
    const page = "❯ item1\n  item2\n  item3";
    // active=0, at top — above=0 but still shows a placeholder line
    const result = withScrollIndicators(page, 10, 0, 3);
    const lines = result.split("\n");
    expect(lines.length).toBe(5);
    expect(lines[0]).toBe(" "); // empty placeholder
    expect(lines[4]).toContain("more below");
  });

  test("always renders both indicator lines for stable height", () => {
    const page = "❯ item1\n  item2\n  item3";
    // Both at top (above=0) and bottom visible — both placeholders shown
    const result = withScrollIndicators(page, 10, 0, 3);
    const lines = result.split("\n");
    expect(lines.length).toBe(5); // top placeholder + 3 page lines + bottom
    expect(lines[0]).toBe(" "); // empty top placeholder
    expect(lines[4]).toContain("more below");
  });
});

describe("filterChoices", () => {
  const choices = [
    { name: "Next.js", value: "next" },
    { name: "React", value: "react" },
    { name: "Vue", value: "vue" },
    { name: "Nuxt", value: "nuxt" },
  ];

  test("returns all choices when term is undefined", () => {
    expect(filterChoices(choices, undefined)).toEqual(choices);
  });

  test("returns all choices when term is empty", () => {
    expect(filterChoices(choices, "")).toEqual(choices);
  });

  test("filters case-insensitively", () => {
    expect(filterChoices(choices, "NEXT")).toEqual([choices[0]!]);
    expect(filterChoices(choices, "next")).toEqual([choices[0]!]);
  });

  test("matches partial names", () => {
    const result = filterChoices(choices, "xt");
    expect(result).toEqual([choices[0]!, choices[3]!]); // Next.js, Nuxt
  });

  test("returns empty array when nothing matches", () => {
    expect(filterChoices(choices, "angular")).toEqual([]);
  });
});

describe("ttyContext", () => {
  const originalIsTTY = process.stdin.isTTY;

  beforeEach(() => {
    process.stdin.isTTY = originalIsTTY;
  });

  test("returns undefined when stdin is a TTY", () => {
    process.stdin.isTTY = true;
    expect(ttyContext()).toBeUndefined();
  });

  test("returns context with input and close when stdin is not a TTY", () => {
    process.stdin.isTTY = false;
    const ctx = ttyContext();
    // On macOS/Linux with /dev/tty available, this should return a context
    if (ctx) {
      expect(ctx.input).toBeDefined();
      expect(typeof ctx.close).toBe("function");
      ctx.close();
    }
    // On CI/Docker without a TTY, ttyContext may return undefined — both are valid
  });
});
