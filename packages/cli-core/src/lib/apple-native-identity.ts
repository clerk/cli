/**
 * Apple treats Bundle IDs as case-insensitive. Keep the original spelling for
 * display and API writes, but use this ASCII-only identity form anywhere a
 * Bundle ID participates in matching or persisted retry identity.
 */
export function normalizeBundleIdentifierIdentity(bundleIdentifier: string): string {
  return bundleIdentifier.replace(/[A-Z]/g, (character) => character.toLowerCase());
}

export function bundleIdentifiersEqual(
  left: string | undefined,
  right: string | undefined,
): boolean {
  return (
    left != null &&
    right != null &&
    normalizeBundleIdentifierIdentity(left) === normalizeBundleIdentifierIdentity(right)
  );
}
