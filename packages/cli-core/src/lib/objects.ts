/**
 * Narrow an unknown value to a plain record. The everywhere-guard for parsed
 * JSON/YAML/TOML shapes: arrays and null are valid JSON but never a valid
 * config table or JSON-RPC frame in this codebase.
 */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Narrow an unknown value to an object carrying a string-valued `key`. */
export function hasStringProp<K extends string>(
  value: unknown,
  key: K,
): value is Record<K, string> {
  return (
    typeof value === "object" &&
    value !== null &&
    Object.prototype.hasOwnProperty.call(value, key) &&
    typeof (value as Record<string, unknown>)[key] === "string"
  );
}
