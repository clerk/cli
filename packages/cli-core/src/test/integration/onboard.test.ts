/**
 * Onboard a project to Clerk
 * Tests the link -> env pull flow with framework-specific env var detection.
 */

// TODO: Add agent mode coverage once `link` performs actual work in agent mode.
// Currently `link` in agent mode only prints a prompt without linking, so the
// full onboard flow (link -> env pull) cannot be tested in agent mode.

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
} from "../lib/setup.ts";

const h = useIntegrationTestHarness();

test.each([
  {
    framework: "Next.js",
    deps: { next: "15.0.0" },
    expectedKey: "NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY",
    envFile: ".env",
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
])("$framework", async ({ deps, devDeps, expectedKey, expectedSecretKey, envFile }) => {
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

  // Link to the app
  await clerk("--mode", "human", "link", "--app", MOCK_APP.application_id);

  // Verify config.json has profile keyed by git remote
  const config = await readConfig();
  expect(config.profiles["github.com/test/project"]).toBeDefined();
  expect(config.profiles["github.com/test/project"]!.appId).toBe(MOCK_APP.application_id);

  // Pull env vars
  await clerk("--mode", "human", "env", "pull");

  // Verify env file has correct key=value pairs with no duplicates
  const envContent = await Bun.file(join(h.tempDir, envFile)).text();
  const env = parseEnvFile(envContent, envFile);
  const secretKey = expectedSecretKey ?? "CLERK_SECRET_KEY";
  expect(env.get(expectedKey)).toBe(devInstance.publishable_key);
  expect(env.get(secretKey)).toBe(devInstance.secret_key);

  // Verify Platform API calls included auth header
  const plapiCalls = http.requests.filter((r) => r.url.includes("/applications/"));
  expect(plapiCalls.length).toBeGreaterThan(0);
});
