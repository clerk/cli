import { test, expect, describe, mock, beforeEach, beforeAll, afterAll, spyOn } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { log } from "./log.ts";

// Sentinel for cancellation. Tests choose this symbol; the mocked
// @clack/prompts.isCancel below treats it as the clack cancel signal.
const cancelSymbol = Symbol.for("clack:cancel");

interface RecordedCall {
  config: Record<string, unknown>;
}

let lastSelectCall: RecordedCall | undefined;
let selectResult: unknown = undefined;
let lastAutocompleteCall: RecordedCall | undefined;
let autocompleteResult: unknown = undefined;
// Each entry answers one autocomplete() call, in order; used to drive filePath's
// drill-in loop across iterations. Falls back to autocompleteResult when empty.
let autocompleteQueue: unknown[] = [];

mock.module("@clack/prompts", () => ({
  select: async (config: Record<string, unknown>) => {
    lastSelectCall = { config };
    return selectResult;
  },
  autocomplete: async (config: Record<string, unknown>) => {
    lastAutocompleteCall = { config };
    return autocompleteQueue.length > 0 ? autocompleteQueue.shift() : autocompleteResult;
  },
  isCancel: (value: unknown): value is symbol => value === cancelSymbol,
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

const {
  select,
  search,
  filePath,
  expandHome,
  listPathChoices,
  filterChoices,
  normalizeChoices,
  Separator,
} = await import("./listage.ts");

beforeEach(() => {
  lastSelectCall = undefined;
  selectResult = undefined;
  lastAutocompleteCall = undefined;
  autocompleteResult = undefined;
  autocompleteQueue = [];
  Object.defineProperty(process.stdin, "isTTY", {
    configurable: true,
    value: true,
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

  test("opens the controlling terminal when stdin is not a TTY", async () => {
    Object.defineProperty(process.stdin, "isTTY", { configurable: true, value: false });
    selectResult = "a";
    const mockStream = { close: mock(() => {}), on: mock(() => mockStream) };
    const createReadStreamSpy = spyOn(await import("node:fs"), "createReadStream").mockReturnValue(
      mockStream as never,
    );

    await select<string>({ message: "Pick", choices: [{ value: "a" }] });

    const expectedPath = process.platform === "win32" ? "CONIN$" : "/dev/tty";
    expect(createReadStreamSpy).toHaveBeenCalledWith(expectedPath);
    expect(lastSelectCall?.config.input).toBe(mockStream);
    expect(mockStream.close).toHaveBeenCalled();

    createReadStreamSpy.mockRestore();
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
    const optionsFn = lastAutocompleteCall?.config.options as (this: {
      userInput: string;
    }) => Array<Record<string, unknown>>;
    const options = optionsFn.call({ userInput: "" });
    expect(options).toHaveLength(2);
    expect(options[0]).toMatchObject({ value: "a", label: "Apple" });
    expect(options[1]).toMatchObject({ value: "b", label: "Banana" });
  });

  test("invokes source again with the typed term when clack requests filtered options", async () => {
    autocompleteResult = "remote-user";
    const terms: Array<string | undefined> = [];

    await search<string>({
      message: "Search users",
      source: (term) => {
        terms.push(term);
        return [{ value: term ?? "initial", name: term ? `User ${term}` : "Initial user" }];
      },
    });

    const options = lastAutocompleteCall?.config.options as (this: {
      userInput: string;
    }) => unknown;
    const refined = options.call({ userInput: "remote" }) as Array<Record<string, unknown>>;

    expect(terms).toEqual([undefined, "remote"]);
    expect(refined[0]).toMatchObject({ value: "remote", label: "User remote" });
  });

  test("refreshes clack state when async source results arrive for the typed term", async () => {
    autocompleteResult = "remote-user";

    await search<string>({
      message: "Search users",
      source: async (term) => [
        { value: term ?? "initial", name: term ? `User ${term}` : "Initial user" },
      ],
    });

    const options = lastAutocompleteCall?.config.options as (this: {
      userInput: string;
      filteredOptions: Array<Record<string, unknown>>;
      selectedValues: unknown[];
      focusedValue: unknown;
      render: () => void;
    }) => Array<Record<string, unknown>>;
    const prompt: {
      userInput: string;
      filteredOptions: Array<Record<string, unknown>>;
      selectedValues: unknown[];
      focusedValue: unknown;
      render: ReturnType<typeof mock>;
    } = {
      userInput: "remote",
      filteredOptions: [],
      selectedValues: [],
      focusedValue: undefined,
      render: mock(),
    };
    const loading = options.call(prompt);
    expect(loading[0]).toMatchObject({ label: "Loading results...", disabled: true });

    await new Promise((resolve) => queueMicrotask(resolve));

    expect(prompt.filteredOptions[0]).toMatchObject({ value: "remote", label: "User remote" });
    expect(prompt.selectedValues).toEqual(["remote"]);
    expect(prompt.focusedValue).toBe("remote");
    expect(prompt.render).toHaveBeenCalled();
  });

  test("rejects submission while autocomplete has no selected value", async () => {
    autocompleteResult = "initial";
    const result = await search<string>({
      message: "Search users",
      source: () => [{ value: "initial", name: "Initial user" }],
    });

    const validate = lastAutocompleteCall?.config.validate as (value: unknown) => unknown;
    expect(result).toBe("initial");
    expect(validate(undefined)).toBe("Select an option to continue");
    expect(validate("initial")).toBeUndefined();
  });

  test("renders async source errors for typed terms without rejecting out of band", async () => {
    autocompleteResult = "initial";

    await search<string>({
      message: "Search users",
      source: async (term) => {
        if (term === "remote") throw new Error("Network down");
        return [{ value: "initial", name: "Initial user" }];
      },
    });

    const options = lastAutocompleteCall?.config.options as (this: {
      userInput: string;
      filteredOptions: Array<Record<string, unknown>>;
      selectedValues: unknown[];
      focusedValue: unknown;
      render: () => void;
    }) => Array<Record<string, unknown>>;
    const prompt: {
      userInput: string;
      filteredOptions: Array<Record<string, unknown>>;
      selectedValues: unknown[];
      focusedValue: unknown;
      render: ReturnType<typeof mock>;
    } = {
      userInput: "remote",
      filteredOptions: [],
      selectedValues: [],
      focusedValue: undefined,
      render: mock(),
    };

    options.call(prompt);
    await new Promise((resolve) => queueMicrotask(resolve));

    expect(prompt.filteredOptions[0]).toMatchObject({
      label: "Network down",
      disabled: true,
    });
    expect(prompt.selectedValues).toEqual([]);
    expect(prompt.focusedValue).toBeUndefined();
    expect(prompt.render).toHaveBeenCalled();
  });

  test("filter accepts source-provided options", async () => {
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
    expect(filter("xyz", { label: "Apple", value: "a" })).toBe(true);
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
    const optionsFn = lastAutocompleteCall?.config.options as (this: {
      userInput: string;
    }) => Array<Record<string, unknown>>;
    const options = optionsFn.call({ userInput: "" });
    expect(options[0]).toMatchObject({ value: "a", label: "A" });
  });
});

describe("expandHome", () => {
  const HOME_CASES = [
    ["~", homedir()],
    ["~/", join(homedir(), "")],
    ["~/Downloads/key.p8", join(homedir(), "Downloads/key.p8")],
    ["/absolute/path", "/absolute/path"],
    ["relative/path", "relative/path"],
    // Only `~` and `~/` are expanded — `~user` is left untouched.
    ["~user/file", "~user/file"],
  ] as const;

  test.each([...HOME_CASES])("expands %s", (input, expected) => {
    expect(expandHome(input)).toBe(expected);
  });
});

describe("listPathChoices", () => {
  let dir: string;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "listage-path-"));
    mkdirSync(join(dir, "nested"));
    writeFileSync(join(dir, "key.p8"), "");
    writeFileSync(join(dir, "key.pub"), "");
    writeFileSync(join(dir, "other.txt"), "");
    writeFileSync(join(dir, "nested", "inner.json"), "");
  });

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("lists a directory's contents when the term ends with a separator", () => {
    expect(listPathChoices(`${dir}/`).map((c) => c.value)).toEqual([
      `${dir}/nested/`,
      `${dir}/key.p8`,
      `${dir}/key.pub`,
      `${dir}/other.txt`,
    ]);
  });

  test("sorts directories before files", () => {
    const choices = listPathChoices(`${dir}/`);
    expect(choices[0]).toMatchObject({ value: `${dir}/nested/`, isDirectory: true });
    expect(choices.slice(1).every((c) => !c.isDirectory)).toBe(true);
  });

  test("appends a trailing slash and flags directories", () => {
    const nested = listPathChoices(`${dir}/`).find((c) => c.value.endsWith("nested/"));
    expect(nested).toEqual({ value: `${dir}/nested/`, name: `${dir}/nested/`, isDirectory: true });
  });

  test("filters by the trailing basename prefix", () => {
    expect(listPathChoices(`${dir}/key`).map((c) => c.value)).toEqual([
      `${dir}/key.p8`,
      `${dir}/key.pub`,
    ]);
  });

  test("preserves the typed prefix instead of resolving to an absolute path", () => {
    expect(listPathChoices(`${dir}/nested/inn`).map((c) => c.value)).toEqual([
      `${dir}/nested/inner.json`,
    ]);
  });

  test("returns an empty list for an unreadable directory", () => {
    expect(listPathChoices(`${dir}/does-not-exist/`)).toEqual([]);
  });

  test("returns an empty list when nothing matches the prefix", () => {
    expect(listPathChoices(`${dir}/zzz`)).toEqual([]);
  });
});

describe("filePath", () => {
  let dir: string;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "listage-filepath-"));
    mkdirSync(join(dir, "nested"));
    writeFileSync(join(dir, "key.p8"), "");
    writeFileSync(join(dir, "nested", "inner.json"), "");
  });

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("returns the selected file after running validate", async () => {
    autocompleteResult = `${dir}/key.p8`;
    let validated: string | undefined;

    const result = await filePath({
      message: "Pick a file",
      validate: (path) => {
        validated = path;
        return true;
      },
    });

    expect(result).toBe(`${dir}/key.p8`);
    expect(validated).toBe(`${dir}/key.p8`);
  });

  test("lists filesystem entries through the options getter", async () => {
    autocompleteResult = `${dir}/key.p8`;
    await filePath({ message: "Pick a file" });

    const optionsFn = lastAutocompleteCall?.config.options as (this: {
      userInput: string;
    }) => Array<{ value: string; label: string }>;
    const options = optionsFn.call({ userInput: `${dir}/` });
    expect(options.map((o) => o.value)).toContain(`${dir}/nested/`);
    const nested = options.find((o) => o.value === `${dir}/nested/`);
    expect(nested?.label).toContain("nested/");
  });

  test("drills into a directory, then returns a file inside it", async () => {
    autocompleteQueue = [`${dir}/nested/`, `${dir}/nested/inner.json`];

    const result = await filePath({ message: "Pick a file" });

    expect(result).toBe(`${dir}/nested/inner.json`);
    // The second prompt is re-seeded inside the chosen directory.
    expect(lastAutocompleteCall?.config.initialUserInput).toBe(`${dir}/nested/`);
  });

  test("re-prompts with the chosen path when validation fails", async () => {
    const warn = spyOn(log, "warn").mockImplementation(() => {});
    autocompleteQueue = [`${dir}/key.p8`, `${dir}/key.p8`];
    let attempts = 0;

    const result = await filePath({
      message: "Pick a file",
      validate: () => {
        attempts += 1;
        return attempts === 1 ? "That file can't be used." : true;
      },
    });

    expect(result).toBe(`${dir}/key.p8`);
    expect(attempts).toBe(2);
    expect(warn).toHaveBeenCalledWith("That file can't be used.");
    expect(lastAutocompleteCall?.config.initialUserInput).toBe(`${dir}/key.p8`);
    warn.mockRestore();
  });
});
