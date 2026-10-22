/**
 * The `connection_oauth_<provider>` entries of an instance's config, as
 * `clerk deploy` reads them and `clerk config patch` saves them.
 */
export const OAUTH_KEY_PREFIX = "connection_oauth_";

/**
 * What `clerk deploy`'s `oauth.setup` payload puts under each credential key
 * for the user to replace: `<client_secret>` under `client_secret`. Only that
 * exact value under that key is a placeholder, so no real credential is ever
 * mistaken for one.
 */
export function credentialPlaceholder(key: string): string {
  return `<${key}>`;
}

export function isCredentialPlaceholder(key: string, value: unknown): boolean {
  return value === credentialPlaceholder(key);
}

/** The fields of a config payload still holding their placeholder, as `connection_oauth_google.client_secret`. */
export function credentialPlaceholderPaths(payload: Record<string, unknown>): string[] {
  return Object.entries(payload).flatMap(([configKey, entry]) =>
    configKey.startsWith(OAUTH_KEY_PREFIX) && entry && typeof entry === "object"
      ? Object.entries(entry)
          .filter(([key, value]) => isCredentialPlaceholder(key, value))
          .map(([key]) => `${configKey}.${key}`)
      : [],
  );
}
