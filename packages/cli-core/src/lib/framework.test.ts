import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  detectPublishableKeyName,
  detectFramework,
  lookupFramework,
  isNpmFramework,
  FRAMEWORK_NAMES,
} from "./framework.ts";

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

  // --- Native platforms (no package.json) ---

  test("detects iOS via .xcodeproj bundle", async () => {
    await mkdir(join(tempDir, "MyApp.xcodeproj"));
    const fw = await detectFramework(tempDir);
    expect(fw!.name).toBe("iOS (Swift)");
    expect(fw!.dep).toBe("ios");
    expect(fw!.ecosystem).toBe("swift");
    expect(fw!.envVar).toBe("CLERK_PUBLISHABLE_KEY");
  });

  test("detects iOS via .xcworkspace bundle", async () => {
    await mkdir(join(tempDir, "MyApp.xcworkspace"));
    expect((await detectFramework(tempDir))!.dep).toBe("ios");
  });

  test("does not detect iOS from a bare Package.swift", async () => {
    await Bun.write(join(tempDir, "Package.swift"), "// swift-tools-version:6.0");
    expect(await detectFramework(tempDir)).toBeNull();
  });

  test("detects Android via app/src/main/AndroidManifest.xml", async () => {
    await Bun.write(join(tempDir, "app/src/main/AndroidManifest.xml"), "<manifest />");
    const fw = await detectFramework(tempDir);
    expect(fw!.name).toBe("Android (Kotlin)");
    expect(fw!.dep).toBe("android");
    expect(fw!.ecosystem).toBe("gradle");
  });

  test("detects Android via src/main/AndroidManifest.xml", async () => {
    await Bun.write(join(tempDir, "src/main/AndroidManifest.xml"), "<manifest />");
    expect((await detectFramework(tempDir))!.dep).toBe("android");
  });

  test("does not detect Android from a bare build.gradle", async () => {
    await Bun.write(join(tempDir, "build.gradle.kts"), "plugins {}");
    expect(await detectFramework(tempDir)).toBeNull();
  });

  test("prefers npm framework over native markers (prebuilt Expo app)", async () => {
    await writePkg(tempDir, { expo: "52.0.0", react: "18.0.0" });
    await Bun.write(join(tempDir, "app/src/main/AndroidManifest.xml"), "<manifest />");
    await mkdir(join(tempDir, "MyApp.xcodeproj"));
    expect((await detectFramework(tempDir))!.name).toBe("Expo");
  });

  test("falls back to native detection when package.json has no framework dep", async () => {
    await writePkg(tempDir, { lodash: "4.0.0" });
    await mkdir(join(tempDir, "MyApp.xcodeproj"));
    expect((await detectFramework(tempDir))!.dep).toBe("ios");
  });
});

describe("native framework lookup", () => {
  test.each(["ios", "android"])("lookupFramework resolves %s", (name) => {
    expect(lookupFramework(name)!.dep).toBe(name);
  });

  test.each(["ios", "android"])("FRAMEWORK_NAMES includes %s", (name) => {
    expect(FRAMEWORK_NAMES).toContain(name);
  });

  test("isNpmFramework distinguishes ecosystems", () => {
    expect(isNpmFramework(lookupFramework("next")!)).toBe(true);
    expect(isNpmFramework(lookupFramework("ios")!)).toBe(false);
    expect(isNpmFramework(lookupFramework("android")!)).toBe(false);
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
