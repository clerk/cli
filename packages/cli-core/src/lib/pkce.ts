/**
 * PKCE (Proof Key for Code Exchange) utilities for OAuth 2.0 public clients.
 * Implements RFC 7636 with S256 challenge method.
 */

const VERIFIER_LENGTH = 43;
const CHARSET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~";
// Largest multiple of CHARSET.length that fits in a byte. Values >= this
// would map non-uniformly via modulo, so reject them (rejection sampling).
const REJECTION_THRESHOLD = 256 - (256 % CHARSET.length);

export function generateCodeVerifier(): string {
  const verifier: string[] = [];
  while (verifier.length < VERIFIER_LENGTH) {
    const bytes = crypto.getRandomValues(new Uint8Array(VERIFIER_LENGTH));
    for (const byte of bytes) {
      if (byte >= REJECTION_THRESHOLD) continue;
      verifier.push(CHARSET.charAt(byte % CHARSET.length));
      if (verifier.length === VERIFIER_LENGTH) break;
    }
  }
  return verifier.join("");
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
