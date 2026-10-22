const SECRET_KEY_NAME = /secret|private_key/i;

/** What `redactSecrets` puts in place of a secret. */
export const REDACTED = "[REDACTED]";

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
    return value && SECRET_KEY_NAME.test(key) ? REDACTED : value;
  }
  if (Array.isArray(value)) return value.map((item) => redactSecrets(item, key));
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value).map(([childKey, child]) => [childKey, redactSecrets(child, childKey)]),
  );
}

/**
 * Where a payload still holds `[REDACTED]` under a key `redactSecrets` covers,
 * as `connection_oauth_google.client_secret`: `clerk config` output fed back
 * in. Saved, the text would replace the real secret. Only that exact value
 * under a secret-named key counts, the same rule the redaction uses.
 */
export function redactedSecretPaths(value: unknown, key = "", path = ""): string[] {
  if (typeof value === "string") {
    return value === REDACTED && SECRET_KEY_NAME.test(key) ? [path] : [];
  }
  if (Array.isArray(value)) {
    return value.flatMap((item, index) => redactedSecretPaths(item, key, `${path}[${index}]`));
  }
  if (!value || typeof value !== "object") return [];
  return Object.entries(value).flatMap(([childKey, child]) =>
    redactedSecretPaths(child, childKey, path ? `${path}.${childKey}` : childKey),
  );
}
