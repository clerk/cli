import { test, expect, describe, spyOn } from "bun:test";
import { generateCodeVerifier, generateCodeChallenge, generateState } from "./pkce.ts";

describe("PKCE", () => {
  test("generateCodeVerifier returns a 43-char string", () => {
    const verifier = generateCodeVerifier();
    expect(verifier.length).toBe(43);
  });

  test("generateCodeVerifier uses only URL-safe characters", () => {
    const verifier = generateCodeVerifier();
    expect(verifier).toMatch(/^[A-Za-z0-9\-._~]+$/);
  });

  test("generateCodeVerifier returns unique values", () => {
    const a = generateCodeVerifier();
    const b = generateCodeVerifier();
    expect(a).not.toBe(b);
  });

  test("generateCodeVerifier skips bytes at and above rejection threshold", () => {
    const REJECTION_THRESHOLD = 256 - (256 % 66);
    let callCount = 0;
    const spy = spyOn(crypto, "getRandomValues").mockImplementation(
      <T extends ArrayBufferView | null>(array: T): T => {
        callCount++;
        if (callCount === 1) {
          (array as Uint8Array).fill(REJECTION_THRESHOLD);
        } else {
          (array as Uint8Array).fill(REJECTION_THRESHOLD - 1);
        }
        return array;
      },
    );

    try {
      const verifier = generateCodeVerifier();
      expect(callCount).toBe(2);
      // byte 197 % 66 = 65 → last charset char '~'
      expect(verifier).toBe("~".repeat(43));
    } finally {
      spy.mockRestore();
    }
  });

  test("rejection sampling maps each accepted byte uniformly to charset", () => {
    const CHARSET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~";
    const REJECTION_THRESHOLD = 256 - (256 % CHARSET.length);
    const counts = new Map<number, number>();

    for (let byte = 0; byte < REJECTION_THRESHOLD; byte++) {
      const index = byte % CHARSET.length;
      counts.set(index, (counts.get(index) ?? 0) + 1);
    }

    expect(counts.size).toBe(CHARSET.length);
    const bytesPerChar = REJECTION_THRESHOLD / CHARSET.length;
    for (const [, count] of counts) {
      expect(count).toBe(bytesPerChar);
    }
  });

  test("generateCodeChallenge produces valid base64url S256 hash", async () => {
    const verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
    const challenge = await generateCodeChallenge(verifier);
    // base64url: no +, /, or = padding
    expect(challenge).toMatch(/^[A-Za-z0-9\-_]+$/);
    expect(challenge.length).toBeGreaterThan(0);
  });

  test("generateCodeChallenge is deterministic for same input", async () => {
    const verifier = "test-verifier-value";
    const a = await generateCodeChallenge(verifier);
    const b = await generateCodeChallenge(verifier);
    expect(a).toBe(b);
  });

  test("generateCodeChallenge differs for different inputs", async () => {
    const a = await generateCodeChallenge("verifier-a");
    const b = await generateCodeChallenge("verifier-b");
    expect(a).not.toBe(b);
  });

  test("generateState returns a non-empty string", () => {
    const state = generateState();
    expect(state.length).toBeGreaterThan(0);
  });

  test("generateState returns unique values", () => {
    const a = generateState();
    const b = generateState();
    expect(a).not.toBe(b);
  });

  test("generateState uses only base64url characters", () => {
    const state = generateState();
    expect(state).toMatch(/^[A-Za-z0-9\-_]+$/);
  });
});
