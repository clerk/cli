import { test, expect, describe } from "bun:test";
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

  test("generateCodeVerifier produces an unbiased distribution", () => {
    // With 66 charset entries and 256-byte modulo, a naive `byte % 66`
    // over-represents the first 58 characters by ~33%. Rejection sampling
    // should keep per-character counts within ~10% of uniform over a
    // large sample.
    const CHARSET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~";
    const counts = new Map<string, number>(CHARSET.split("").map((c) => [c, 0]));
    const iterations = 2000;
    for (let i = 0; i < iterations; i++) {
      for (const ch of generateCodeVerifier()) {
        counts.set(ch, (counts.get(ch) ?? 0) + 1);
      }
    }
    const total = iterations * 43;
    const expected = total / CHARSET.length;
    const tolerance = expected * 0.1;
    for (const [, count] of counts) {
      expect(Math.abs(count - expected)).toBeLessThan(tolerance);
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
