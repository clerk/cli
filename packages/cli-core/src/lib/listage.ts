/**
 * List prompts powered by @clack/prompts. Provides select() and search()
 * with the same exported shape the rest of the codebase expects. Cancel
 * is translated to UserAbortError at the wrapper boundary.
 */

import {
  select as clackSelect,
  autocomplete as clackAutocomplete,
  type Option as ClackOption,
} from "@clack/prompts";
import { isCancel } from "@clack/core";
import { throwUserAbort } from "./errors.ts";

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
  const result = await clackSelect<Value>({
    message: config.message,
    options: toClackOptions(items),
    initialValue: config.default,
    maxItems: config.pageSize,
  });
  return unwrap(result);
}

// ---------------------------------------------------------------------------
// Search prompt (autocomplete)
// ---------------------------------------------------------------------------

export type SearchChoice<Value> = SelectChoice<Value>;

export type SearchConfig<Value> = {
  message: string;
  /**
   * One-shot source. Called once with `undefined`; the returned list is
   * filtered client-side by clack via the `filter` callback as the user
   * types. The async signal is accepted for signature compatibility but
   * unused — clack drives cancellation itself.
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

export async function search<Value>(config: SearchConfig<Value>): Promise<Value> {
  const controller = new AbortController();
  const raw = await config.source(undefined, { signal: controller.signal });
  const items = normalizeChoices(raw);
  const options = toClackOptions(items);

  const result = await clackAutocomplete<Value>({
    message: config.message,
    options,
    initialValue: config.default,
    maxItems: config.pageSize,
    filter: (term, opt) => {
      const label = (opt.label ?? String(opt.value)).toLowerCase();
      return label.includes(term.toLowerCase());
    },
  });
  return unwrap(result);
}
