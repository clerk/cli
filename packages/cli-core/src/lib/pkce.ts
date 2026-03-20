/**
 * PKCE (Proof Key for Code Exchange) utilities for OAuth 2.0 public clients.
 * Implements RFC 7636 with S256 challenge method.
 */

const VERIFIER_LENGTH = 43;
const CHARSET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~";

export function generateCodeVerifier(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(VERIFIER_LENGTH));
  let verifier = "";
  for (const byte of bytes) {
    verifier += CHARSET[byte % CHARSET.length];
  }
  return verifier;
}

export async function generateCodeChallenge(verifier: string): Promise<string> {
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(verifier);
  const digest = hasher.digest();
  return base64UrlEncode(digest);
}

export function generateState(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return base64UrlEncode(bytes);
}

function base64UrlEncode(buffer: Uint8Array): string {
  const base64 = Buffer.from(buffer).toString("base64");
  return base64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
