import { isRecord } from "../../lib/objects.ts";
import type { CheckDef, CheckInput, InstanceConfig } from "./types.ts";

// PATCH semantics: objects merge, arrays and primitives replace.
export function deepMerge(
  base: Record<string, unknown>,
  overlay: Record<string, unknown>,
): Record<string, unknown> {
  const result: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(overlay)) {
    const existing = result[key];
    result[key] = isRecord(existing) && isRecord(value) ? deepMerge(existing, value) : value;
  }
  return result;
}

export interface ProjectedPatches {
  payload: Record<string, unknown>;
  projected: InstanceConfig;
}

// Each patch sees the previous ones' result, so checks touching the same array
// or object compose, and a check already satisfied is skipped regardless of order.
export function projectPatches(input: CheckInput, checks: CheckDef[]): ProjectedPatches {
  let payload: Record<string, unknown> = {};
  let projected = input.config;
  for (const check of checks) {
    if (!check.patch) continue;
    const current = { ...input, config: projected };
    if (check.evaluate(current).met) continue;
    const patch = check.patch(current);
    payload = deepMerge(payload, patch);
    projected = deepMerge(projected, patch);
  }
  return { payload, projected };
}
