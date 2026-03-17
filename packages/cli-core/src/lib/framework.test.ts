import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { detectPublishableKeyName, detectFramework } from "./framework.ts";

function writePkg(dir: string, deps: Record<string, string>, devDeps?: Record<string, string>) {
  return Bun.write(
    join(dir, "package.json"),
    JSON.stringify({
      ...(Object.keys(deps).length > 0 ? { dependencies: deps } : {}),
      ...(devDeps ? { devDependencies: devDeps } : {}),
    }),
  );
}

describe("detectFramework", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "clerk-framework-test-"));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  // --- Every supported framework ---

  test("detects Next.js", async () => {
    await writePkg(tempDir, { next: "15.0.0", react: "19.0.0" });
    const fw = await detectFramework(tempDir);
    expect(fw!.name).toBe("Next.js");
    expect(fw!.sdk).toBe("@clerk/nextjs");
    expect(fw!.envVar).toBe("NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY");
  });

  test("detects Astro", async () => {
    await writePkg(tempDir, { astro: "5.0.0" });
    const fw = await detectFramework(tempDir);
    expect(fw!.name).toBe("Astro");
    expect(fw!.sdk).toBe("@clerk/astro");
    expect(fw!.envVar).toBe("PUBLIC_CLERK_PUBLISHABLE_KEY");
  });

  test("detects Nuxt", async () => {
    await writePkg(tempDir, { nuxt: "3.0.0", vue: "3.0.0" });
    const fw = await detectFramework(tempDir);
    expect(fw!.name).toBe("Nuxt");
    expect(fw!.sdk).toBe("@clerk/nuxt");
    expect(fw!.envVar).toBe("NUXT_PUBLIC_CLERK_PUBLISHABLE_KEY");
  });

  test("detects TanStack Start", async () => {
    await writePkg(tempDir, { "@tanstack/react-start": "1.0.0", react: "19.0.0" });
    const fw = await detectFramework(tempDir);
    expect(fw!.name).toBe("TanStack Start");
    expect(fw!.sdk).toBe("@clerk/tanstack-react-start");
    expect(fw!.envVar).toBe("VITE_CLERK_PUBLISHABLE_KEY");
  });

  test("detects React Router", async () => {
    await writePkg(tempDir, { "react-router": "7.0.0", react: "19.0.0" });
    const fw = await detectFramework(tempDir);
    expect(fw!.name).toBe("React Router");
    expect(fw!.sdk).toBe("@clerk/react-router");
    expect(fw!.envVar).toBe("VITE_CLERK_PUBLISHABLE_KEY");
  });

  test("detects Vue standalone", async () => {
    await writePkg(tempDir, { vue: "3.0.0" });
    const fw = await detectFramework(tempDir);
    expect(fw!.name).toBe("Vue");
    expect(fw!.sdk).toBe("@clerk/vue");
    expect(fw!.envVar).toBe("VITE_CLERK_PUBLISHABLE_KEY");
  });

  test("detects React standalone", async () => {
    await writePkg(tempDir, { react: "19.0.0" });
    const fw = await detectFramework(tempDir);
    expect(fw!.name).toBe("React");
    expect(fw!.sdk).toBe("@clerk/react");
    expect(fw!.envVar).toBe("VITE_CLERK_PUBLISHABLE_KEY");
  });

  test("detects Expo", async () => {
    await writePkg(tempDir, { expo: "52.0.0", react: "18.0.0" });
    const fw = await detectFramework(tempDir);
    expect(fw!.name).toBe("Expo");
    expect(fw!.sdk).toBe("@clerk/expo");
    expect(fw!.envVar).toBe("EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY");
  });

  test("detects Express", async () => {
    await writePkg(tempDir, { express: "4.0.0" });
    const fw = await detectFramework(tempDir);
    expect(fw!.name).toBe("Express");
    expect(fw!.sdk).toBe("@clerk/express");
    expect(fw!.envVar).toBe("CLERK_PUBLISHABLE_KEY");
  });

  test("detects Fastify", async () => {
    await writePkg(tempDir, { fastify: "4.0.0" });
    const fw = await detectFramework(tempDir);
    expect(fw!.name).toBe("Fastify");
    expect(fw!.sdk).toBe("@clerk/fastify");
    expect(fw!.envVar).toBe("CLERK_PUBLISHABLE_KEY");
  });

  // --- Priority / ordering ---

  test("prefers Next.js over React", async () => {
    await writePkg(tempDir, { next: "15.0.0", react: "19.0.0" });
    expect((await detectFramework(tempDir))!.name).toBe("Next.js");
  });

  test("prefers Nuxt over Vue", async () => {
    await writePkg(tempDir, { nuxt: "3.0.0", vue: "3.0.0" });
    expect((await detectFramework(tempDir))!.name).toBe("Nuxt");
  });

  test("prefers TanStack Start over React", async () => {
    await writePkg(tempDir, { "@tanstack/react-start": "1.0.0", react: "19.0.0" });
    expect((await detectFramework(tempDir))!.name).toBe("TanStack Start");
  });

  test("prefers React Router over React", async () => {
    await writePkg(tempDir, { "react-router": "7.0.0", react: "19.0.0" });
    expect((await detectFramework(tempDir))!.name).toBe("React Router");
  });

  test("prefers Expo over React", async () => {
    await writePkg(tempDir, { expo: "52.0.0", react: "18.0.0" });
    expect((await detectFramework(tempDir))!.name).toBe("Expo");
  });

  // --- Edge cases ---

  test("returns null when no framework detected", async () => {
    await writePkg(tempDir, { lodash: "4.0.0" });
    expect(await detectFramework(tempDir)).toBeNull();
  });

  test("returns null when no package.json exists", async () => {
    expect(await detectFramework(tempDir)).toBeNull();
  });

  test("returns null for malformed package.json", async () => {
    await Bun.write(join(tempDir, "package.json"), "not json");
    expect(await detectFramework(tempDir)).toBeNull();
  });

  test("detects from devDependencies", async () => {
    await writePkg(tempDir, {}, { next: "15.0.0" });
    expect((await detectFramework(tempDir))!.name).toBe("Next.js");
  });
});

describe("detectPublishableKeyName", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "clerk-framework-test-"));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  test("returns NEXT_PUBLIC_* for Next.js", async () => {
    await writePkg(tempDir, { next: "15.0.0" });
    expect(await detectPublishableKeyName(tempDir)).toBe("NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY");
  });

  test("returns VITE_* for React", async () => {
    await writePkg(tempDir, { react: "19.0.0" });
    expect(await detectPublishableKeyName(tempDir)).toBe("VITE_CLERK_PUBLISHABLE_KEY");
  });

  test("returns fallback for unknown deps", async () => {
    await writePkg(tempDir, { lodash: "4.0.0" });
    expect(await detectPublishableKeyName(tempDir)).toBe("CLERK_PUBLISHABLE_KEY");
  });

  test("returns fallback when no package.json", async () => {
    expect(await detectPublishableKeyName(tempDir)).toBe("CLERK_PUBLISHABLE_KEY");
  });
});
