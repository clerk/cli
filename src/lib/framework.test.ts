import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { detectPublishableKeyName } from "./framework";

describe("detectPublishableKeyName", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "clerk-framework-test-"));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  test("returns NEXT_PUBLIC_* for Next.js projects", async () => {
    await Bun.write(
      join(tempDir, "package.json"),
      JSON.stringify({ dependencies: { next: "14.0.0" } }),
    );
    expect(await detectPublishableKeyName(tempDir)).toBe(
      "NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY",
    );
  });

  test("returns VITE_* for Vite projects", async () => {
    await Bun.write(
      join(tempDir, "package.json"),
      JSON.stringify({ devDependencies: { vite: "5.0.0" } }),
    );
    expect(await detectPublishableKeyName(tempDir)).toBe(
      "VITE_CLERK_PUBLISHABLE_KEY",
    );
  });

  test("returns PUBLIC_* for Astro projects", async () => {
    await Bun.write(
      join(tempDir, "package.json"),
      JSON.stringify({ dependencies: { astro: "4.0.0" } }),
    );
    expect(await detectPublishableKeyName(tempDir)).toBe(
      "PUBLIC_CLERK_PUBLISHABLE_KEY",
    );
  });

  test("returns EXPO_PUBLIC_* for Expo projects", async () => {
    await Bun.write(
      join(tempDir, "package.json"),
      JSON.stringify({ dependencies: { expo: "50.0.0" } }),
    );
    expect(await detectPublishableKeyName(tempDir)).toBe(
      "EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY",
    );
  });

  test("returns NUXT_PUBLIC_* for Nuxt projects", async () => {
    await Bun.write(
      join(tempDir, "package.json"),
      JSON.stringify({ dependencies: { nuxt: "3.0.0" } }),
    );
    expect(await detectPublishableKeyName(tempDir)).toBe(
      "NUXT_PUBLIC_CLERK_PUBLISHABLE_KEY",
    );
  });

  test("prefers Next.js over Vite when both present", async () => {
    await Bun.write(
      join(tempDir, "package.json"),
      JSON.stringify({
        dependencies: { next: "14.0.0" },
        devDependencies: { vite: "5.0.0" },
      }),
    );
    expect(await detectPublishableKeyName(tempDir)).toBe(
      "NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY",
    );
  });

  test("returns fallback when no framework detected", async () => {
    await Bun.write(
      join(tempDir, "package.json"),
      JSON.stringify({ dependencies: { express: "4.0.0" } }),
    );
    expect(await detectPublishableKeyName(tempDir)).toBe(
      "CLERK_PUBLISHABLE_KEY",
    );
  });

  test("returns fallback when no package.json exists", async () => {
    expect(await detectPublishableKeyName(tempDir)).toBe(
      "CLERK_PUBLISHABLE_KEY",
    );
  });

  test("returns fallback for malformed package.json", async () => {
    await Bun.write(join(tempDir, "package.json"), "not json");
    expect(await detectPublishableKeyName(tempDir)).toBe(
      "CLERK_PUBLISHABLE_KEY",
    );
  });
});
