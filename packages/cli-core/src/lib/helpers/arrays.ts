/**
 * Generic array helpers and type-narrowing predicates.
 */

/** A readonly array proven to contain at least one element. */
export type NonEmptyArray<T> = readonly [T, ...T[]];

/**
 * Type guard: narrows a `readonly T[]` to `NonEmptyArray<T>` when it has
 * one or more elements. Use at boundaries where you want the type system
 * (rather than a runtime null-check) to prove an array is non-empty.
 *
 * @example
 * ```ts
 * const items = await getItems();
 * if (!isNonEmpty(items)) {
 *   return;
 * }
 * // items is now NonEmptyArray<Item> — items[0] is Item, not Item | undefined
 * ```
 */
export function isNonEmpty<T>(arr: readonly T[]): arr is NonEmptyArray<T> {
  return arr.length > 0;
}
