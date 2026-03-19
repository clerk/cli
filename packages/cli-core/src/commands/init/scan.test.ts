import { test, expect, describe, beforeEach, afterEach, spyOn } from "bun:test";
import { join } from "node:path";
import { mkdtemp, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { detectAuthLibraries, scanForIssues } from "./scan.ts";

// ---------------------------------------------------------------------------
// detectAuthLibraries
// ---------------------------------------------------------------------------

describe("detectAuthLibraries", () => {
  let consoleSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    consoleSpy = spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    consoleSpy.mockRestore();
  });

  test("detects NextAuth", () => {
    detectAuthLibraries({ "next-auth": "5.0.0", next: "15.0.0" });
    const output = consoleSpy.mock.calls.map((c: unknown[]) => c[0]).join("\n");
    expect(output).toContain("NextAuth");
    expect(output).toContain("clerk.com/docs/migrations/nextauth");
  });

  test("detects Auth0 via @auth0/nextjs-auth0", () => {
    detectAuthLibraries({ "@auth0/nextjs-auth0": "3.0.0" });
    const output = consoleSpy.mock.calls.map((c: unknown[]) => c[0]).join("\n");
    expect(output).toContain("Auth0");
  });

  test("detects Auth0 via auth0 package", () => {
    detectAuthLibraries({ auth0: "4.0.0" });
    const output = consoleSpy.mock.calls.map((c: unknown[]) => c[0]).join("\n");
    expect(output).toContain("Auth0");
  });

  test("detects Supabase Auth via @supabase/ssr", () => {
    detectAuthLibraries({ "@supabase/ssr": "0.5.0" });
    const output = consoleSpy.mock.calls.map((c: unknown[]) => c[0]).join("\n");
    expect(output).toContain("Supabase Auth");
  });

  test("detects Firebase", () => {
    detectAuthLibraries({ firebase: "11.0.0" });
    const output = consoleSpy.mock.calls.map((c: unknown[]) => c[0]).join("\n");
    expect(output).toContain("Firebase");
  });

  test("detects Passport.js", () => {
    detectAuthLibraries({ passport: "0.7.0" });
    const output = consoleSpy.mock.calls.map((c: unknown[]) => c[0]).join("\n");
    expect(output).toContain("Passport.js");
  });

  test("detects Better Auth", () => {
    detectAuthLibraries({ "better-auth": "1.0.0" });
    const output = consoleSpy.mock.calls.map((c: unknown[]) => c[0]).join("\n");
    expect(output).toContain("Better Auth");
  });

  test("detects Kinde", () => {
    detectAuthLibraries({ "@kinde-oss/kinde-auth-nextjs": "2.0.0" });
    const output = consoleSpy.mock.calls.map((c: unknown[]) => c[0]).join("\n");
    expect(output).toContain("Kinde");
  });

  test("detects multiple auth libraries", () => {
    detectAuthLibraries({ "next-auth": "5.0.0", firebase: "11.0.0" });
    const output = consoleSpy.mock.calls.map((c: unknown[]) => c[0]).join("\n");
    expect(output).toContain("NextAuth");
    expect(output).toContain("Firebase");
  });

  test("does not warn when no auth library found", () => {
    detectAuthLibraries({ react: "19.0.0", next: "15.0.0" });
    expect(consoleSpy).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// scanForIssues
// ---------------------------------------------------------------------------

describe("scanForIssues", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "clerk-scan-"));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  test("detects hardcoded publishable key", async () => {
    await mkdir(join(tempDir, "src"), { recursive: true });
    await Bun.write(
      join(tempDir, "src/config.ts"),
      'const key = "pk_test_abc123";\nCLERK_PUBLISHABLE_KEY = pk_live_xyz;',
    );

    const findings = await scanForIssues(tempDir, "next");
    expect(findings.length).toBeGreaterThan(0);
    expect(findings[0]!.message).toContain("publishable key");
  });

  test("detects hardcoded secret key", async () => {
    await mkdir(join(tempDir, "src"), { recursive: true });
    await Bun.write(join(tempDir, "src/env.ts"), "CLERK_SECRET_KEY = sk_test_abc123;");

    const findings = await scanForIssues(tempDir, "next");
    expect(findings.length).toBeGreaterThan(0);
    expect(findings[0]!.message).toContain("secret key");
  });

  test("detects NextAuth import for next framework", async () => {
    await mkdir(join(tempDir, "src"), { recursive: true });
    await Bun.write(
      join(tempDir, "src/auth.ts"),
      'import { getServerSession } from "next-auth";\n',
    );

    const findings = await scanForIssues(tempDir, "next");
    expect(findings.some((f) => f.message.includes("NextAuth import"))).toBe(true);
  });

  test("skips NextAuth scan for non-next frameworks", async () => {
    await mkdir(join(tempDir, "src"), { recursive: true });
    await Bun.write(
      join(tempDir, "src/auth.ts"),
      'import { getServerSession } from "next-auth";\n',
    );

    const findings = await scanForIssues(tempDir, "react");
    expect(findings.some((f) => f.message.includes("NextAuth import"))).toBe(false);
  });

  test("detects getServerSession call", async () => {
    await mkdir(join(tempDir, "src"), { recursive: true });
    await Bun.write(
      join(tempDir, "src/api.ts"),
      "const session = await getServerSession(authOptions);\n",
    );

    const findings = await scanForIssues(tempDir, "next");
    expect(findings.some((f) => f.message.includes("getServerSession"))).toBe(true);
  });

  test("detects Firebase Auth import", async () => {
    await mkdir(join(tempDir, "src"), { recursive: true });
    await Bun.write(
      join(tempDir, "src/auth.ts"),
      'import { signInWithPopup } from "firebase/auth";\n',
    );

    const findings = await scanForIssues(tempDir, "react");
    expect(findings.some((f) => f.message.includes("Firebase Auth"))).toBe(true);
  });

  test("detects Better Auth import", async () => {
    await mkdir(join(tempDir, "src"), { recursive: true });
    await Bun.write(join(tempDir, "src/auth.ts"), 'import { auth } from "better-auth";\n');

    const findings = await scanForIssues(tempDir, "react");
    expect(findings.some((f) => f.message.includes("Better Auth"))).toBe(true);
  });

  test("detects Passport import", async () => {
    await mkdir(join(tempDir, "src"), { recursive: true });
    await Bun.write(join(tempDir, "src/auth.ts"), 'import passport from "passport";\n');

    const findings = await scanForIssues(tempDir, "next");
    expect(findings.some((f) => f.message.includes("Passport"))).toBe(true);
  });

  test("returns correct line number", async () => {
    await mkdir(join(tempDir, "src"), { recursive: true });
    await Bun.write(
      join(tempDir, "src/auth.ts"),
      'const a = 1;\nconst b = 2;\nimport { auth } from "better-auth";\n',
    );

    const findings = await scanForIssues(tempDir, "react");
    const finding = findings.find((f) => f.message.includes("Better Auth"));
    expect(finding).toBeDefined();
    expect(finding!.line).toBe(3);
  });

  test("returns empty array when no issues found", async () => {
    await mkdir(join(tempDir, "src"), { recursive: true });
    await Bun.write(
      join(tempDir, "src/app.ts"),
      'import { ClerkProvider } from "@clerk/nextjs";\n',
    );

    const findings = await scanForIssues(tempDir, "next");
    expect(findings).toEqual([]);
  });

  test("returns all findings without a cap", async () => {
    await mkdir(join(tempDir, "src"), { recursive: true });
    // Create 12 files with hardcoded keys
    for (let i = 0; i < 12; i++) {
      await Bun.write(join(tempDir, `src/file${i}.ts`), `CLERK_SECRET_KEY = sk_test_${i};`);
    }

    const findings = await scanForIssues(tempDir, "next");
    expect(findings.length).toBe(12);
  });

  test("ignores node_modules", async () => {
    await mkdir(join(tempDir, "node_modules/some-pkg"), { recursive: true });
    await Bun.write(
      join(tempDir, "node_modules/some-pkg/index.js"),
      'import { auth } from "better-auth";\n',
    );

    const findings = await scanForIssues(tempDir, "react");
    expect(findings).toEqual([]);
  });

  test("ignores nested node_modules in monorepo", async () => {
    await mkdir(join(tempDir, "packages/app/node_modules/dep"), { recursive: true });
    await Bun.write(
      join(tempDir, "packages/app/node_modules/dep/index.js"),
      'import { auth } from "better-auth";\n',
    );

    const findings = await scanForIssues(tempDir, "react");
    expect(findings).toEqual([]);
  });

  test("ignores .next directory", async () => {
    await mkdir(join(tempDir, ".next/server"), { recursive: true });
    await Bun.write(
      join(tempDir, ".next/server/chunks.js"),
      'import { auth } from "better-auth";\n',
    );

    const findings = await scanForIssues(tempDir, "react");
    expect(findings).toEqual([]);
  });
});
