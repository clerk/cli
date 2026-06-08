/**
 * List prompts powered by @clack/prompts. Provides select() and search()
 * with the same exported shape the rest of the codebase expects. Cancel
 * is translated to UserAbortError at the wrapper boundary.
 */

import { createReadStream } from "node:fs";
import type { Readable } from "node:stream";
import {
  select as clackSelect,
  autocomplete as clackAutocomplete,
  isCancel,
  type Option as ClackOption,
} from "@clack/prompts";
import { throwUserAbort } from "./errors.ts";

// ---------------------------------------------------------------------------
// Shared utilities
// ---------------------------------------------------------------------------

const TTY_PATH = process.platform === "win32" ? "CONIN$" : "/dev/tty";

export function ttyContext(): { input: Readable; close: () => void } | undefined {
  if (process.stdin.isTTY) return undefined;
  try {
    const input = createReadStream(TTY_PATH);
    input.on("error", () => {});
    return { input, close: () => input.close() };
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Separator — kept as a tiny local class so call sites compile unchanged.
// Rendered as a disabled clack option with a dim label.
// ---------------------------------------------------------------------------

export class Separator {
  static readonly TYPE = "separator" as const;
  readonly type = Separator.TYPE;
  constructor(public readonly separator: string = "──────────────") {}
  static isSeparator(value: unknown): value is Separator {
    return value instanceof Separator;
  }
}

// ---------------------------------------------------------------------------
// Choice types — preserve the existing public API
// ---------------------------------------------------------------------------

export type NormalizedChoice<Value> = {
  value: Value;
  name: string;
  short: string;
  disabled: boolean | string;
  description?: string;
};

type SelectChoice<Value> = {
  value: Value;
  name?: string;
  description?: string;
  short?: string;
  disabled?: boolean | string;
};

export function filterChoices<T extends { name: string }>(
  choices: T[],
  term: string | undefined,
): T[] {
  if (!term) return choices;
  const lower = term.toLowerCase();
  return choices.filter((c) => c.name.toLowerCase().includes(lower));
}

export function normalizeChoices<Value>(
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

// Sentinel used so a Separator can be passed through clack as a disabled option.
const SEPARATOR_VALUE = Symbol("listage:separator");

// clack's `Option<Value>` is a conditional type that distributes over unions,
// so `Option<Value | symbol>` collapses into incompatible branches. We build
// option records that satisfy the non-primitive branch (label required) and
// cast at the boundary.
function toClackOptions<Value>(
  items: ReadonlyArray<NormalizedChoice<Value> | Separator>,
): ClackOption<Value>[] {
  return items.map((item) => {
    if (Separator.isSeparator(item)) {
      return {
        value: SEPARATOR_VALUE as unknown as Value,
        label: item.separator,
        disabled: true,
      };
    }
    return {
      value: item.value,
      label: item.name,
      hint: item.description,
      disabled: item.disabled ? true : undefined,
    };
  }) as ClackOption<Value>[];
}

function unwrap<T>(value: T | symbol): T {
  if (isCancel(value)) throwUserAbort();
  if (value === SEPARATOR_VALUE) {
    throw new Error("listage: separator received as selected value");
  }
  return value as T;
}

function isPromiseLike<T>(value: T | Promise<T>): value is Promise<T> {
  return typeof (value as Promise<T>)?.then === "function";
}

// ---------------------------------------------------------------------------
// Select prompt
// ---------------------------------------------------------------------------

export type SelectConfig<Value> = {
  message: string;
  choices: ReadonlyArray<Separator | Value | SelectChoice<Value>>;
  pageSize?: number;
  default?: Value;
};

export async function select<Value>(config: SelectConfig<Value>): Promise<Value> {
  const items = normalizeChoices(config.choices);
  const tty = ttyContext();
  try {
    const result = await clackSelect<Value>({
      message: config.message,
      options: toClackOptions(items),
      initialValue: config.default,
      maxItems: config.pageSize,
      input: tty?.input,
    });
    return unwrap(result);
  } finally {
    tty?.close();
  }
}

// ---------------------------------------------------------------------------
// Search prompt (autocomplete)
// ---------------------------------------------------------------------------

export type SearchChoice<Value> = SelectChoice<Value>;

export type SearchConfig<Value> = {
  message: string;
  /**
   * Source called with the current search term. Async sources are cached per
   * term and refresh the prompt when their results arrive.
   */
  source: (
    term: string | undefined,
    opts: { signal: AbortSignal },
  ) =>
    | ReadonlyArray<Separator | Value | SearchChoice<Value>>
    | Promise<ReadonlyArray<Separator | Value | SearchChoice<Value>>>;
  pageSize?: number;
  default?: Value;
};

type AutocompleteContext = {
  userInput?: string;
  filteredOptions?: Array<{ value: unknown; label?: string; hint?: string; disabled?: boolean }>;
  selectedValues?: unknown[];
  focusedValue?: unknown;
};

export async function search<Value>(config: SearchConfig<Value>): Promise<Value> {
  const cache = new Map<string, ClackOption<Value>[]>();
  const pending = new Map<string, Promise<void>>();

  const normalizeTerm = (term: string | undefined) => term ?? "";
  const toSourceTerm = (term: string) => (term === "" ? undefined : term);
  const disabledOption = (label: string): ClackOption<Value>[] =>
    [
      {
        value: SEPARATOR_VALUE as unknown as Value,
        label,
        disabled: true,
      },
    ] as ClackOption<Value>[];
  const loading = () => disabledOption("Loading results...");

  const setCache = (term: string, raw: ReadonlyArray<Separator | Value | SearchChoice<Value>>) => {
    cache.set(term, toClackOptions(normalizeChoices(raw)));
  };

  const setError = (term: string, error: unknown) => {
    cache.set(term, disabledOption(error instanceof Error ? error.message : String(error)));
  };

  const refresh = (term: string, prompt: AutocompleteContext | undefined) => {
    if (!prompt || prompt.userInput !== term) return;
    const options = cache.get(term);
    if (!options) return;

    const first = options.find((option) => !option.disabled);
    prompt.filteredOptions = options as Array<{
      value: unknown;
      label?: string;
      hint?: string;
      disabled?: boolean;
    }>;
    prompt.focusedValue = first?.value;
    prompt.selectedValues = first ? [first.value] : [];
    (prompt as AutocompleteContext & { render?: () => void }).render?.();
  };

  const load = (term: string, prompt?: AutocompleteContext): ClackOption<Value>[] => {
    const cached = cache.get(term);
    if (cached) return cached;

    if (!pending.has(term)) {
      const controller = new AbortController();
      let result:
        | ReadonlyArray<Separator | Value | SearchChoice<Value>>
        | Promise<ReadonlyArray<Separator | Value | SearchChoice<Value>>>;
      try {
        result = config.source(toSourceTerm(term), { signal: controller.signal });
      } catch (error) {
        setError(term, error);
        refresh(term, prompt);
        return cache.get(term)!;
      }

      if (isPromiseLike(result)) {
        pending.set(
          term,
          result
            .then((raw) => {
              setCache(term, raw);
              refresh(term, prompt);
            })
            .catch((error) => {
              setError(term, error);
              refresh(term, prompt);
            })
            .finally(() => {
              pending.delete(term);
            }),
        );
      } else {
        setCache(term, result);
        return cache.get(term)!;
      }
    }

    return loading();
  };

  const initialController = new AbortController();
  setCache("", await config.source(undefined, { signal: initialController.signal }));

  const tty = ttyContext();
  try {
    const result = await clackAutocomplete<Value>({
      message: config.message,
      options: function (this: AutocompleteContext) {
        return load(normalizeTerm(this.userInput), this);
      },
      initialValue: config.default,
      maxItems: config.pageSize,
      filter: () => true,
      validate: (value) => (value === undefined ? "Select an option to continue" : undefined),
      input: tty?.input,
    });
    return unwrap(result);
  } finally {
    tty?.close();
  }
}
