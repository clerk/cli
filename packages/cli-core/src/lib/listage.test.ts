import { test, expect, describe, mock, beforeEach } from "bun:test";

// Sentinel for cancellation. Tests choose this symbol; the mocked
// @clack/core.isCancel below treats it as the clack cancel signal.
const cancelSymbol = Symbol.for("clack:cancel");

interface RecordedCall {
  config: Record<string, unknown>;
}

let lastSelectCall: RecordedCall | undefined;
let selectResult: unknown = undefined;
let lastAutocompleteCall: RecordedCall | undefined;
let autocompleteResult: unknown = undefined;

mock.module("@clack/prompts", () => ({
  select: async (config: Record<string, unknown>) => {
    lastSelectCall = { config };
    return selectResult;
  },
  autocomplete: async (config: Record<string, unknown>) => {
    lastAutocompleteCall = { config };
    return autocompleteResult;
  },
  // Stubs for sibling tests that may share this process.
  confirm: async () => true,
  text: async () => "",
  password: async () => "",
  intro: () => {},
  outro: () => {},
  cancel: () => {},
  log: { info: () => {}, warn: () => {}, error: () => {}, success: () => {} },
  spinner: () => ({ start: () => {}, stop: () => {}, message: () => {} }),
}));

mock.module("@clack/core", () => ({
  isCancel: (value: unknown): value is symbol => value === cancelSymbol,
}));

const { select, search, filterChoices, normalizeChoices, Separator } = await import("./listage.ts");

beforeEach(() => {
  lastSelectCall = undefined;
  selectResult = undefined;
  lastAutocompleteCall = undefined;
  autocompleteResult = undefined;
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
    expect(result).toEqual([choices[0]!, choices[3]!]);
  });

  test("returns empty array when nothing matches", () => {
    expect(filterChoices(choices, "angular")).toEqual([]);
  });
});

describe("normalizeChoices", () => {
  test("normalizes primitive choices into name/value pairs", () => {
    const result = normalizeChoices(["a", "b"]);
    expect(result).toEqual([
      { value: "a", name: "a", short: "a", disabled: false },
      { value: "b", name: "b", short: "b", disabled: false },
    ]);
  });

  test("normalizes object choices and defaults name/short to value", () => {
    const result = normalizeChoices([{ value: "x" }, { value: "y", name: "Y label" }]);
    expect(result).toEqual([
      { value: "x", name: "x", short: "x", disabled: false },
      { value: "y", name: "Y label", short: "Y label", disabled: false },
    ]);
  });

  test("preserves description and disabled when present", () => {
    const result = normalizeChoices([
      { value: "a", name: "A", description: "the A", disabled: "soon" },
    ]);
    expect(result[0]).toEqual({
      value: "a",
      name: "A",
      short: "A",
      disabled: "soon",
      description: "the A",
    });
  });

  test("preserves separators verbatim", () => {
    const sep = new Separator("---");
    const result = normalizeChoices([{ value: "a", name: "A" }, sep, { value: "b", name: "B" }]);
    expect(Separator.isSeparator(result[0])).toBe(false);
    expect(Separator.isSeparator(result[1])).toBe(true);
    expect(result[1]).toBe(sep);
    expect(Separator.isSeparator(result[2])).toBe(false);
  });
});

describe("Separator", () => {
  test("has a default rule string and identifies itself", () => {
    const sep = new Separator();
    expect(Separator.isSeparator(sep)).toBe(true);
    expect(typeof sep.separator).toBe("string");
    expect(sep.separator.length).toBeGreaterThan(0);
  });

  test("accepts a custom separator label", () => {
    const sep = new Separator("---");
    expect(sep.separator).toBe("---");
  });

  test("isSeparator rejects non-separator values", () => {
    expect(Separator.isSeparator({ separator: "---" })).toBe(false);
    expect(Separator.isSeparator(undefined)).toBe(false);
    expect(Separator.isSeparator("---")).toBe(false);
  });
});

describe("select", () => {
  test("passes message, options, initialValue, and maxItems through to clack", async () => {
    selectResult = "a";
    const result = await select<string>({
      message: "Pick one",
      choices: [
        { value: "a", name: "A", description: "first" },
        { value: "b", name: "B" },
      ],
      default: "b",
      pageSize: 5,
    });

    expect(result).toBe("a");
    expect(lastSelectCall?.config.message).toBe("Pick one");
    expect(lastSelectCall?.config.initialValue).toBe("b");
    expect(lastSelectCall?.config.maxItems).toBe(5);
    const options = lastSelectCall?.config.options as Array<Record<string, unknown>>;
    expect(options).toHaveLength(2);
    expect(options[0]).toMatchObject({ value: "a", label: "A", hint: "first" });
    expect(options[1]).toMatchObject({ value: "b", label: "B" });
  });

  test("renders separators as disabled options with the separator label", async () => {
    selectResult = "b";
    await select<string>({
      message: "Pick",
      choices: [{ value: "a", name: "A" }, new Separator("--- divider ---"), { value: "b" }],
    });
    const options = lastSelectCall?.config.options as Array<Record<string, unknown>>;
    expect(options).toHaveLength(3);
    expect(options[1]).toMatchObject({ label: "--- divider ---", disabled: true });
    // The separator value is a sentinel symbol — not equal to either real value.
    expect(typeof options[1]?.value).toBe("symbol");
  });

  test("marks disabled choices on the clack option", async () => {
    selectResult = "a";
    await select<string>({
      message: "Pick",
      choices: [
        { value: "a", name: "A" },
        { value: "b", name: "B", disabled: true },
      ],
    });
    const options = lastSelectCall?.config.options as Array<Record<string, unknown>>;
    expect(options[0]?.disabled).toBeUndefined();
    expect(options[1]?.disabled).toBe(true);
  });

  test("throws UserAbortError when clack returns the cancel symbol", async () => {
    selectResult = cancelSymbol;
    await expect(
      select<string>({ message: "Pick", choices: [{ value: "a" }] }),
    ).rejects.toMatchObject({ name: "UserAbortError" });
  });
});

describe("search", () => {
  test("invokes source once, forwards options to clack, and returns the result", async () => {
    autocompleteResult = "a";
    let sourceCalls = 0;
    let lastTerm: string | undefined = "initial-marker";

    const result = await search<string>({
      message: "Search",
      pageSize: 4,
      default: "a",
      source: (term) => {
        sourceCalls += 1;
        lastTerm = term;
        return [
          { value: "a", name: "Apple" },
          { value: "b", name: "Banana" },
        ];
      },
    });

    expect(result).toBe("a");
    expect(sourceCalls).toBe(1);
    expect(lastTerm).toBeUndefined();
    expect(lastAutocompleteCall?.config.message).toBe("Search");
    expect(lastAutocompleteCall?.config.maxItems).toBe(4);
    expect(lastAutocompleteCall?.config.initialValue).toBe("a");
    const options = lastAutocompleteCall?.config.options as Array<Record<string, unknown>>;
    expect(options).toHaveLength(2);
    expect(options[0]).toMatchObject({ value: "a", label: "Apple" });
    expect(options[1]).toMatchObject({ value: "b", label: "Banana" });
  });

  test("filter callback matches labels case-insensitively", async () => {
    autocompleteResult = "a";
    await search<string>({
      message: "Search",
      source: () => [
        { value: "a", name: "Apple" },
        { value: "b", name: "Banana" },
      ],
    });

    const filter = lastAutocompleteCall?.config.filter as (
      term: string,
      opt: { label?: string; value: unknown },
    ) => boolean;
    expect(typeof filter).toBe("function");
    expect(filter("APP", { label: "Apple", value: "a" })).toBe(true);
    expect(filter("ban", { label: "Banana", value: "b" })).toBe(true);
    expect(filter("xyz", { label: "Apple", value: "a" })).toBe(false);
    // Falls back to stringifying value when label is absent.
    expect(filter("a", { value: "a" })).toBe(true);
  });

  test("throws UserAbortError when clack returns the cancel symbol", async () => {
    autocompleteResult = cancelSymbol;
    await expect(
      search<string>({
        message: "Search",
        source: () => [{ value: "a", name: "A" }],
      }),
    ).rejects.toMatchObject({ name: "UserAbortError" });
  });

  test("accepts a Promise from source", async () => {
    autocompleteResult = "a";
    const result = await search<string>({
      message: "Search",
      source: async () => [{ value: "a", name: "A" }],
    });
    expect(result).toBe("a");
    const options = lastAutocompleteCall?.config.options as Array<Record<string, unknown>>;
    expect(options[0]).toMatchObject({ value: "a", label: "A" });
  });
});
