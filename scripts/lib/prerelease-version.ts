export function toSemverSafeCommitIdentifier(shortSha: string): string {
  // Semver treats all-digit prerelease identifiers as numeric. Prefix those so
  // npm and Bun both preserve the exact version string instead of normalizing
  // or rejecting values like "0405146".
  return /^\d+$/.test(shortSha) ? `g${shortSha}` : shortSha;
}

export function replaceChangesetsCommit(version: string, shortSha: string): string {
  return version.replace(/\b[a-f0-9]{40}\b/, toSemverSafeCommitIdentifier(shortSha));
}
