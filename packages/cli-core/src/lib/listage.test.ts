import { test, expect, describe, beforeEach } from "bun:test";
import {
  filterChoices,
  normalizeChoices,
  renderSearchItem,
  scrollBounds,
  Separator,
  ttyContext,
  withScrollIndicators,
} from "./listage.ts";

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

  // Invariant must hold for any active position and any pageSize — including
  // odd pageSizes where above/below may drift by ±1 at boundaries.
  const PAGE_SIZES = [5, 7];
  const SCROLL_CASES = PAGE_SIZES.flatMap((pageSize) =>
    Array.from({ length: 20 }, (_, active) => ({ pageSize, active })),
  );

  test.each(SCROLL_CASES)(
    "above + below + pageSize = totalItems (pageSize=$pageSize, active=$active)",
    ({ pageSize, active }) => {
      const { above, below } = scrollBounds(20, active, pageSize);
      expect(above + below + pageSize).toBe(20);
    },
  );
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

describe("normalizeChoices", () => {
  test("forwards style hook from choice to normalized item", () => {
    const style = (text: string, isActive: boolean) => `[${isActive ? "on" : "off"}]${text}`;
    // Cast through unknown: SelectChoice doesn't expose `style` at the type
    // level, but normalizeChoices preserves it at runtime so SearchChoice
    // callers can opt in.
    const choices = [
      { value: "a", name: "A" },
      { value: "b", name: "B", style },
    ] as unknown as Parameters<typeof normalizeChoices<string>>[0];
    const result = normalizeChoices(choices);
    const a = result[0] as Exclude<(typeof result)[number], Separator>;
    const b = result[1] as Exclude<(typeof result)[number], Separator>;
    expect(a.style).toBeUndefined();
    expect(b.style).toBe(style);
  });

  test("preserves separators", () => {
    const sep = new Separator();
    const result = normalizeChoices([{ value: "a", name: "A" }, sep, { value: "b", name: "B" }]);
    expect(Separator.isSeparator(result[0])).toBe(false);
    expect(Separator.isSeparator(result[1])).toBe(true);
    expect(Separator.isSeparator(result[2])).toBe(false);
  });
});

describe("renderSearchItem", () => {
  const theme = {
    icon: { cursor: ">" },
    style: {
      disabled: (text: string) => `[disabled]${text}`,
      highlight: (text: string) => `[highlight]${text}`,
    },
  };
  const baseItem = {
    value: "a",
    name: "Choice A",
    short: "A",
    disabled: false as boolean | string,
  };

  test("uses default highlight when active and no style hook is set", () => {
    expect(renderSearchItem(baseItem, true, theme)).toBe("[highlight]> Choice A");
  });

  test("returns plain text when inactive and no style hook is set", () => {
    expect(renderSearchItem(baseItem, false, theme)).toBe("  Choice A");
  });

  test("invokes the style hook when set, bypassing the default highlight", () => {
    const style = (text: string, isActive: boolean) => `[${isActive ? "on" : "off"}]${text}`;
    const styled = { ...baseItem, style };
    expect(renderSearchItem(styled, true, theme)).toBe("[on]> Choice A");
    expect(renderSearchItem(styled, false, theme)).toBe("[off]  Choice A");
  });

  test("style hook receives cursor + name with no extra wrapping", () => {
    let received: { text: string; isActive: boolean } | undefined;
    const style = (text: string, isActive: boolean) => {
      received = { text, isActive };
      return text;
    };
    renderSearchItem({ ...baseItem, style }, true, theme);
    expect(received).toEqual({ text: "> Choice A", isActive: true });
  });

  test("renders separators verbatim with a leading space", () => {
    expect(renderSearchItem(new Separator("---"), false, theme)).toBe(" ---");
  });

  test("renders disabled choices with the disabled style and ignores style hook", () => {
    const style = (text: string) => `[styled]${text}`;
    const disabled = { ...baseItem, disabled: true as boolean | string, style };
    expect(renderSearchItem(disabled, false, theme)).toBe("[disabled]Choice A (disabled)");
  });

  test("uses the disabled string label when provided", () => {
    const disabled = { ...baseItem, disabled: "coming soon" as boolean | string };
    expect(renderSearchItem(disabled, false, theme)).toBe("[disabled]Choice A coming soon");
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
