const SECRET_KEY_NAME = /secret|private_key/i;

/**
 * Config as the CLI shows it, with client secrets and private keys replaced by
 * `[REDACTED]`. The diff before a write, the response after it, and the
 * `--verbose` log of that response go to the terminal and to whatever captures
 * an agent's or CI job's output, so a secret is shown as changed, never shown.
 * Matched by key name, since none of those has a schema to consult. `key` is
 * the name the value sits under; arrays inherit it.
 */
export function redactSecrets(value: unknown, key = ""): unknown {
  if (typeof value === "string") {
    return value && SECRET_KEY_NAME.test(key) ? "[REDACTED]" : value;
  }
  if (Array.isArray(value)) return value.map((item) => redactSecrets(item, key));
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value).map(([childKey, child]) => [childKey, redactSecrets(child, childKey)]),
  );
}
