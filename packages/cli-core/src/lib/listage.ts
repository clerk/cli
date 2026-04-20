/**
 * Interactive list prompts with scroll indicators.
 *
 * Custom select/search prompts built on @inquirer/core that show
 * "↑ N more above" / "↓ N more below" when the list overflows the
 * visible page. Also includes the piped-stdin TTY fallback so prompts
 * work even when stdin has been consumed by a pipe.
 */

import { createReadStream } from "node:fs";
import {
  createPrompt,
  useState,
  useKeypress,
  usePrefix,
  usePagination,
  useRef,
  useMemo,
  useEffect,
  isBackspaceKey,
  isEnterKey,
  isUpKey,
  isDownKey,
  isNumberKey,
  isTabKey,
  Separator,
  ValidationError,
  makeTheme,
} from "@inquirer/core";
import type { Theme } from "@inquirer/core";
import { cursorHide, cursorShow } from "@inquirer/ansi";
import { styleText } from "node:util";
import figures from "@inquirer/figures";
import type { PartialDeep } from "@inquirer/type";

// ---------------------------------------------------------------------------
// Shared utilities
// ---------------------------------------------------------------------------

const TTY_PATH = process.platform === "win32" ? "CONIN$" : "/dev/tty";

export function ttyContext(): { input: NodeJS.ReadableStream; close: () => void } | undefined {
  if (process.stdin.isTTY) return undefined;
  try {
    const input = createReadStream(TTY_PATH);
    // Swallow open errors (Docker without --tty, detached CI runners, Windows
    // sessions without CONIN$) so the prompt falls back to the default stdin
    // instead of crashing with an unhandled error event.
    input.on("error", () => {});
    return { input, close: () => input.close() };
  } catch {
    return undefined;
  }
}

/** Case-insensitive name filter — shared by search-based prompts. */
export function filterChoices<T extends { name: string }>(
  choices: T[],
  term: string | undefined,
): T[] {
  if (!term) return choices;
  const lower = term.toLowerCase();
  return choices.filter((c) => c.name.toLowerCase().includes(lower));
}

// ---------------------------------------------------------------------------
// Scroll indicator helpers
// ---------------------------------------------------------------------------

/**
 * Calculate how many items sit above/below the visible page window.
 *
 * Approximates `usePagination`'s `usePointerPosition` logic for
 * `loop: false`, assuming every item renders as a single line.
 *
 * Known imprecisions:
 * - For odd `pageSize` values (e.g. 7, middle=3), the counts may be off
 *   by ±1 near the boundary where the window starts scrolling, because
 *   `usePagination` only slides once the active item would cross out of
 *   the visible range, whereas this function slides at `active > middle`.
 * - Long labels that wrap in narrow terminals produce multi-line rendered
 *   items, causing the counts to drift from the actual rendered window.
 *
 * These are cosmetic — the indicator text ("3 more above") may be off by
 * one in edge cases but the prompt remains fully functional.
 */
export function scrollBounds(
  totalItems: number,
  active: number,
  pageSize: number,
): { above: number; below: number } {
  if (totalItems <= pageSize) return { above: 0, below: 0 };

  const middle = Math.floor(pageSize / 2);
  const spaceBelow = totalItems - active;

  let firstVisible: number;
  if (spaceBelow < pageSize - middle) {
    // Near the bottom — window slides to show the last pageSize items.
    firstVisible = totalItems - pageSize;
  } else if (active <= middle) {
    // Near the top — window starts at 0.
    firstVisible = 0;
  } else {
    // Middle — active is roughly centered.
    firstVisible = active - middle;
  }

  const lastVisible = Math.min(firstVisible + pageSize - 1, totalItems - 1);
  return {
    above: firstVisible,
    below: totalItems - 1 - lastVisible,
  };
}

/**
 * Wrap the page string returned by `usePagination` with scroll indicators.
 *
 * Always renders both indicator lines when called (even if count is 0) so
 * the total height stays stable as the user scrolls — preventing terminal
 * jitter from line-count changes between renders.
 */
export function withScrollIndicators(
  page: string,
  totalItems: number,
  active: number,
  effectivePageSize: number,
): string {
  const { above, below } = scrollBounds(totalItems, active, effectivePageSize);
  const top = above > 0 ? styleText("dim", ` ${figures.arrowUp} ${above} more above`) : " ";
  const bottom = below > 0 ? styleText("dim", ` ${figures.arrowDown} ${below} more below`) : " ";
  return [top, page, bottom].join("\n");
}

// ---------------------------------------------------------------------------
// Shared item helpers
// ---------------------------------------------------------------------------

function isSelectable<T>(item: T | Separator): item is T & { disabled?: boolean | string } {
  return !Separator.isSeparator(item) && !(item as { disabled?: boolean | string }).disabled;
}

type NormalizedChoice<Value> = {
  value: Value;
  name: string;
  short: string;
  disabled: boolean | string;
  description?: string;
};

function normalizeChoices<Value>(
  choices: ReadonlyArray<Value | SelectChoice<Value> | Separator>,
): Array<NormalizedChoice<Value> | Separator> {
  return choices.map((choice) => {
    if (Separator.isSeparator(choice)) return choice;
    if (typeof choice !== "object" || choice === null || !("value" in (choice as object))) {
      const name = String(choice);
      return { value: choice as Value, name, short: name, disabled: false };
    }
    const c = choice as SelectChoice<Value>;
    const name = c.name ?? String(c.value);
    const normalized: NormalizedChoice<Value> = {
      value: c.value,
      name,
      short: c.short ?? name,
      disabled: c.disabled ?? false,
    };
    if (c.description) normalized.description = c.description;
    return normalized;
  });
}

// ---------------------------------------------------------------------------
// Select prompt
// ---------------------------------------------------------------------------

type SelectTheme = {
  icon: { cursor: string };
  style: {
    disabled: (text: string) => string;
    description: (text: string) => string;
    keysHelpTip: (keys: [key: string, action: string][]) => string | undefined;
  };
  i18n: { disabledError: string };
  indexMode: "hidden" | "number";
};

type SelectChoice<Value> = {
  value: Value;
  name?: string;
  description?: string;
  short?: string;
  disabled?: boolean | string;
};

export type SelectConfig<Value> = {
  message: string;
  choices: ReadonlyArray<Separator | Value | SelectChoice<Value>>;
  pageSize?: number;
  default?: Value;
  theme?: PartialDeep<Theme<SelectTheme>>;
};

const selectTheme: SelectTheme = {
  icon: { cursor: figures.pointer },
  style: {
    disabled: (text: string) => styleText("dim", text),
    description: (text: string) => styleText("cyan", text),
    keysHelpTip: (keys: [key: string, action: string][]) =>
      keys
        .map(([key, action]) => `${styleText("bold", key)} ${styleText("dim", action)}`)
        .join(styleText("dim", " • ")),
  },
  i18n: { disabledError: "This option is disabled and cannot be selected." },
  indexMode: "hidden",
};

const rawSelect = createPrompt<unknown, SelectConfig<unknown>>((config, done) => {
  const { pageSize = 7 } = config;
  const theme = makeTheme(selectTheme, config.theme);
  const [status, setStatus] = useState<string>("idle");
  const prefix = usePrefix({ status, theme });
  const searchTimeoutRef = useRef<ReturnType<typeof setTimeout>>();

  const items = useMemo(() => normalizeChoices(config.choices), [config.choices]);

  const bounds = useMemo(() => {
    const first = items.findIndex(isSelectable);
    const last = items.findLastIndex(isSelectable);
    if (first === -1) {
      throw new ValidationError("[select prompt] No selectable choices. All choices are disabled.");
    }
    return { first, last };
  }, [items]);

  const defaultItemIndex = useMemo(() => {
    if (!("default" in config)) return -1;
    return items.findIndex((item) => isSelectable(item) && item.value === config.default);
  }, [config.default, items]);

  const [active, setActive] = useState(defaultItemIndex === -1 ? bounds.first : defaultItemIndex);

  const selectedChoice = items[active];
  if (selectedChoice == null || Separator.isSeparator(selectedChoice)) {
    throw new Error("Active index does not point to a choice");
  }

  const [errorMsg, setError] = useState<string>();

  useKeypress((key, rl) => {
    clearTimeout(searchTimeoutRef.current);
    if (errorMsg) setError(undefined);

    if (isEnterKey(key)) {
      if (selectedChoice.disabled) {
        setError(theme.i18n.disabledError);
      } else {
        setStatus("done");
        done(selectedChoice.value);
      }
    } else if (isUpKey(key) || isDownKey(key)) {
      rl.clearLine(0);
      if ((isUpKey(key) && active !== bounds.first) || (isDownKey(key) && active !== bounds.last)) {
        const offset = isUpKey(key) ? -1 : 1;
        let next = active;
        do {
          next = (next + offset + items.length) % items.length;
        } while (!isSelectable(items[next]!));
        setActive(next);
      }
    } else if (isNumberKey(key) && !Number.isNaN(Number(rl.line))) {
      const selectedIndex = Number(rl.line) - 1;
      let selectableIndex = -1;
      const position = items.findIndex((item) => {
        if (Separator.isSeparator(item)) return false;
        selectableIndex++;
        return selectableIndex === selectedIndex;
      });
      const item = items[position];
      if (item != null && isSelectable(item)) setActive(position);
      searchTimeoutRef.current = setTimeout(() => rl.clearLine(0), 700);
    } else if (isBackspaceKey(key)) {
      rl.clearLine(0);
    } else {
      // Type-ahead search
      const searchTerm = rl.line.toLowerCase();
      const matchIndex = items.findIndex(
        (item) => isSelectable(item) && item.name.toLowerCase().startsWith(searchTerm),
      );
      if (matchIndex !== -1) setActive(matchIndex);
      searchTimeoutRef.current = setTimeout(() => rl.clearLine(0), 700);
    }
  });

  useEffect(() => () => clearTimeout(searchTimeoutRef.current), []);

  const message = theme.style.message(config.message, status);
  const helpLine = theme.style.keysHelpTip([
    ["↑↓", "navigate"],
    ["⏎", "select"],
  ]);

  // Pagination with scroll indicators
  const needsScroll = items.length > pageSize;
  const effectivePageSize = needsScroll ? Math.max(pageSize - 2, 3) : pageSize;

  let separatorCount = 0;
  const page = usePagination({
    items,
    active,
    renderItem({ item, isActive, index }) {
      if (Separator.isSeparator(item)) {
        separatorCount++;
        return ` ${item.separator}`;
      }
      const cursor = isActive ? theme.icon.cursor : " ";
      const indexLabel = theme.indexMode === "number" ? `${index + 1 - separatorCount}. ` : "";
      if (item.disabled) {
        const disabledLabel = typeof item.disabled === "string" ? item.disabled : "(disabled)";
        const disabledCursor = isActive ? theme.icon.cursor : "-";
        return theme.style.disabled(`${disabledCursor} ${indexLabel}${item.name} ${disabledLabel}`);
      }
      const color = isActive ? theme.style.highlight : (x: string) => x;
      return color(`${cursor} ${indexLabel}${item.name}`);
    },
    pageSize: effectivePageSize,
    loop: false,
  });

  if (status === "done") {
    return `${[prefix, message, theme.style.answer(selectedChoice.short)].filter(Boolean).join(" ")}${cursorShow}`;
  }

  const pageWithScroll = needsScroll
    ? withScrollIndicators(page, items.length, active, effectivePageSize)
    : page;

  const { description } = selectedChoice;
  const lines = [
    [prefix, message].filter(Boolean).join(" "),
    pageWithScroll,
    " ",
    description ? theme.style.description(description) : "",
    errorMsg ? theme.style.error(errorMsg) : "",
    helpLine,
  ]
    .filter(Boolean)
    .join("\n")
    .trimEnd();

  return `${lines}${cursorHide}`;
});

/** Select prompt with scroll indicators and piped-stdin TTY fallback. */
export async function select<Value>(config: SelectConfig<Value>): Promise<Value> {
  const tty = ttyContext();
  try {
    return (await rawSelect(
      config as SelectConfig<unknown>,
      tty ? { input: tty.input } : undefined,
    )) as Value;
  } finally {
    tty?.close();
  }
}

// ---------------------------------------------------------------------------
// Search prompt
// ---------------------------------------------------------------------------

type SearchTheme = {
  icon: { cursor: string };
  style: {
    disabled: (text: string) => string;
    searchTerm: (text: string) => string;
    description: (text: string) => string;
    keysHelpTip: (keys: [key: string, action: string][]) => string | undefined;
  };
};

type SearchChoice<Value> = {
  value: Value;
  name?: string;
  description?: string;
  short?: string;
  disabled?: boolean | string;
};

export type SearchConfig<Value> = {
  message: string;
  source: (
    term: string | undefined,
    opt: { signal: AbortSignal },
  ) =>
    | ReadonlyArray<Separator | Value | SearchChoice<Value>>
    | Promise<ReadonlyArray<Separator | Value | SearchChoice<Value>>>;
  validate?: (value: Value) => boolean | string | Promise<string | boolean>;
  pageSize?: number;
  default?: Value;
  theme?: PartialDeep<Theme<SearchTheme>>;
};

const searchTheme: SearchTheme = {
  icon: { cursor: figures.pointer },
  style: {
    disabled: (text: string) => styleText("dim", `- ${text}`),
    searchTerm: (text: string) => styleText("cyan", text),
    description: (text: string) => styleText("cyan", text),
    keysHelpTip: (keys: [key: string, action: string][]) =>
      keys
        .map(([key, action]) => `${styleText("bold", key)} ${styleText("dim", action)}`)
        .join(styleText("dim", " • ")),
  },
};

const rawSearch = createPrompt<unknown, SearchConfig<unknown>>((config, done) => {
  const { pageSize = 7, validate = () => true } = config;
  const theme = makeTheme(searchTheme, config.theme);
  const [status, setStatus] = useState<string>("loading");
  const [searchTerm, setSearchTerm] = useState("");
  const [searchResults, setSearchResults] = useState<Array<NormalizedChoice<unknown> | Separator>>(
    [],
  );
  const [searchError, setSearchError] = useState<string>();
  const defaultApplied = useRef(false);
  const prefix = usePrefix({ status, theme });

  const bounds = useMemo(() => {
    const first = searchResults.findIndex(isSelectable);
    const last = searchResults.findLastIndex(isSelectable);
    return { first, last };
  }, [searchResults]);

  const defaultActive = bounds.first === -1 ? 0 : bounds.first;
  const [active = defaultActive, setActive] = useState<number>();

  useEffect(() => {
    const controller = new AbortController();
    setStatus("loading");
    setSearchError(undefined);

    const fetchResults = async () => {
      try {
        const results = await config.source(searchTerm || undefined, {
          signal: controller.signal,
        });
        if (!controller.signal.aborted) {
          const normalized = normalizeChoices(results as ReadonlyArray<unknown>);
          let initialActive: number | undefined;
          if (!defaultApplied.current && "default" in config) {
            const defaultIndex = normalized.findIndex(
              (item) => isSelectable(item) && item.value === config.default,
            );
            initialActive = defaultIndex === -1 ? undefined : defaultIndex;
            defaultApplied.current = true;
          }
          setActive(initialActive);
          setSearchError(undefined);
          setSearchResults(normalized);
          setStatus("idle");
        }
      } catch (error: unknown) {
        if (!controller.signal.aborted && error instanceof Error) {
          setSearchError(error.message);
          setStatus("idle");
        }
      }
    };

    void fetchResults();
    return () => controller.abort();
  }, [searchTerm]);

  const selectedChoice = searchResults[active] as NormalizedChoice<unknown> | undefined;

  useKeypress(async (key, rl) => {
    if (isEnterKey(key)) {
      if (selectedChoice) {
        setStatus("loading");
        const isValid = await validate(selectedChoice.value);
        setStatus("idle");
        if (isValid === true) {
          setStatus("done");
          done(selectedChoice.value);
        } else if (selectedChoice.name === searchTerm) {
          setSearchError((isValid as string) || "You must provide a valid value");
        } else {
          rl.write(selectedChoice.name);
          setSearchTerm(selectedChoice.name);
        }
      } else {
        rl.write(searchTerm);
      }
    } else if (isTabKey(key) && selectedChoice) {
      rl.clearLine(0);
      rl.write(selectedChoice.name);
      setSearchTerm(selectedChoice.name);
    } else if (
      status !== "loading" &&
      searchResults.length > 0 &&
      bounds.first !== -1 &&
      (isUpKey(key) || isDownKey(key))
    ) {
      rl.clearLine(0);
      if ((isUpKey(key) && active !== bounds.first) || (isDownKey(key) && active !== bounds.last)) {
        const offset = isUpKey(key) ? -1 : 1;
        let next = active;
        do {
          next = (next + offset + searchResults.length) % searchResults.length;
        } while (!isSelectable(searchResults[next]!));
        setActive(next);
      }
    } else {
      setSearchTerm(rl.line);
    }
  });

  const message = theme.style.message(config.message, status);
  const helpLine = theme.style.keysHelpTip([
    ["↑↓", "navigate"],
    ["⏎", "select"],
  ]);

  // Pagination with scroll indicators
  const needsScroll = searchResults.length > pageSize;
  const effectivePageSize = needsScroll ? Math.max(pageSize - 2, 3) : pageSize;

  const page = usePagination({
    items: searchResults,
    active,
    renderItem({ item, isActive }) {
      if (Separator.isSeparator(item)) return ` ${item.separator}`;
      if (item.disabled) {
        const disabledLabel = typeof item.disabled === "string" ? item.disabled : "(disabled)";
        return theme.style.disabled(`${item.name} ${disabledLabel}`);
      }
      const color = isActive ? theme.style.highlight : (x: string) => x;
      const cursor = isActive ? theme.icon.cursor : " ";
      return color(`${cursor} ${item.name}`);
    },
    pageSize: effectivePageSize,
    loop: false,
  });

  let error: string | undefined;
  if (searchError) {
    error = theme.style.error(searchError);
  } else if (searchResults.length === 0 && searchTerm !== "" && status === "idle") {
    error = theme.style.error("No results found");
  }

  if (status === "done" && selectedChoice) {
    return `${[prefix, message, theme.style.answer(selectedChoice.short)].filter(Boolean).join(" ").trimEnd()}${cursorShow}`;
  }

  const searchStr = theme.style.searchTerm(searchTerm);

  const pageWithScroll =
    needsScroll && !error
      ? withScrollIndicators(page, searchResults.length, active, effectivePageSize)
      : page;

  const description = selectedChoice?.description;
  const header = [prefix, message, searchStr].filter(Boolean).join(" ").trimEnd();
  const body = [
    error ?? pageWithScroll,
    " ",
    description ? theme.style.description(description) : "",
    helpLine,
  ]
    .filter(Boolean)
    .join("\n")
    .trimEnd();

  return [header, body];
});

/** Search prompt with scroll indicators and piped-stdin TTY fallback. */
export async function search<Value>(config: SearchConfig<Value>): Promise<Value> {
  const tty = ttyContext();
  try {
    return (await rawSearch(
      config as SearchConfig<unknown>,
      tty ? { input: tty.input } : undefined,
    )) as Value;
  } finally {
    tty?.close();
  }
}

export { Separator };
