/**
 * Onboard a project to Clerk
 * Tests the link -> env pull flow with framework-specific env var detection.
 */

import { test, expect } from "bun:test";
import { join } from "node:path";
import {
  useIntegrationTestHarness,
  http,
  readConfig,
  parseEnvFile,
  clerk,
  getInstance,
  MOCK_APP,
} from "./lib/harness.ts";

const h = useIntegrationTestHarness();
const MODES = ["human", "agent"] as const;

for (const mode of MODES) {
  test.each([
    {
      framework: "Next.js",
      deps: { next: "15.0.0" },
      expectedKey: "NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY",
      envFile: ".env.local",
    },
    {
      framework: "React/Vite",
      deps: { react: "19.0.0" },
      devDeps: { vite: "6.0.0" },
      expectedKey: "VITE_CLERK_PUBLISHABLE_KEY",
      envFile: ".env.local",
    },
    {
      framework: "Express",
      deps: { express: "4.21.0" },
      expectedKey: "CLERK_PUBLISHABLE_KEY",
      envFile: ".env.local",
    },
    {
      framework: "Astro",
      deps: { astro: "5.0.0" },
      expectedKey: "PUBLIC_CLERK_PUBLISHABLE_KEY",
      envFile: ".env",
    },
    {
      framework: "Expo",
      deps: { expo: "52.0.0" },
      expectedKey: "EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY",
      envFile: ".env.local",
    },
    {
      framework: "Nuxt",
      deps: { nuxt: "3.0.0" },
      expectedKey: "NUXT_PUBLIC_CLERK_PUBLISHABLE_KEY",
      expectedSecretKey: "NUXT_CLERK_SECRET_KEY",
      envFile: ".env",
    },
    {
      framework: "TanStack Start",
      deps: { "@tanstack/react-start": "1.0.0", react: "19.0.0" },
      expectedKey: "VITE_CLERK_PUBLISHABLE_KEY",
      envFile: ".env.local",
    },
    {
      framework: "React Router",
      deps: { "react-router": "7.0.0", react: "19.0.0" },
      expectedKey: "VITE_CLERK_PUBLISHABLE_KEY",
      envFile: ".env.local",
    },
    {
      framework: "Vue",
      deps: { vue: "3.0.0" },
      expectedKey: "VITE_CLERK_PUBLISHABLE_KEY",
      envFile: ".env.local",
    },
    {
      framework: "Fastify",
      deps: { fastify: "5.0.0" },
      expectedKey: "CLERK_PUBLISHABLE_KEY",
      envFile: ".env.local",
    },
    {
      framework: "No framework (fallback)",
      deps: { lodash: "4.0.0" },
      expectedKey: "CLERK_PUBLISHABLE_KEY",
      envFile: ".env.local",
    },
  ])(`$framework (${mode})`, async ({ deps, devDeps, expectedKey, expectedSecretKey, envFile }) => {
    const pkg = {
      name: "test-project",
      dependencies: deps,
      ...(devDeps ? { devDependencies: devDeps } : {}),
    };
    await Bun.write(join(h.tempDir, "package.json"), JSON.stringify(pkg));

    const devInstance = getInstance(MOCK_APP, "development");

    http.mock({
      [`/applications/${MOCK_APP.application_id}`]: MOCK_APP,
    });

    await clerk("--mode", mode, "link", "--app", MOCK_APP.application_id);

    const config = await readConfig();
    expect(config.profiles["github.com/test/project"]).toBeDefined();
    expect(config.profiles["github.com/test/project"]!.appId).toBe(MOCK_APP.application_id);

    await clerk("--mode", mode, "env", "pull");

    const envContent = await Bun.file(join(h.tempDir, envFile)).text();
    const env = parseEnvFile(envContent, envFile);
    const secretKey = expectedSecretKey ?? "CLERK_SECRET_KEY";
    expect(env.get(expectedKey)).toBe(devInstance.publishable_key);
    expect(env.get(secretKey)).toBe(devInstance.secret_key);

    const plapiCalls = http.requests.filter((r) => r.url.includes("/applications/"));
    expect(plapiCalls.length).toBeGreaterThan(0);
  });
}
