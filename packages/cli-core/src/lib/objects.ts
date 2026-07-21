/**
 * Narrow an unknown value to a plain record. The everywhere-guard for parsed
 * JSON/YAML/TOML shapes: arrays and null are valid JSON but never a valid
 * config table or JSON-RPC frame in this codebase.
 */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
