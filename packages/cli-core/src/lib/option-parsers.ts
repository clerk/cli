import { throwUsageError } from "./errors.ts";

/** Commander option reducer: accumulate repeated `--flag value` occurrences into an array. */
export function collectOptionValues(value: string, previous: string[] = []): string[] {
  return [...previous, value];
}

/** Parse and range-validate an integer option value, throwing a usage error on bad input. */
export function parseIntegerOption(
  value: string,
  flag: string,
  { min, max }: { min: number; max?: number },
): number {
  if (!/^-?\d+$/.test(value)) {
    throwUsageError(`Invalid ${flag} value "${value}". Must be an integer.`);
  }

  const parsed = Number.parseInt(value, 10);
  if (parsed < min || (typeof max === "number" && parsed > max)) {
    const range = typeof max === "number" ? `${min}-${max}` : `>= ${min}`;
    throwUsageError(`Invalid ${flag} value "${value}". Must be ${range}.`);
  }

  return parsed;
}
