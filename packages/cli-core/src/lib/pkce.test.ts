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
