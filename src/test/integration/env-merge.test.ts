/**
 * Env pull merge behavior
 * Tests that `env pull` correctly merges Clerk keys into existing .env files,
 * preserves non-Clerk variables, updates stale keys in-place, and respects
 * the --file flag.
 */

import { test, expect, beforeEach } from "bun:test";
import { join } from "node:path";
import {
  useIntegrationTestHarness,
  installFetchMock,
  parseEnvFile,
  setProfile,
  clerk,
  getInstance,
  MOCK_APP,
} from "./setup.ts";

const h = useIntegrationTestHarness();

const devInstance = getInstance(MOCK_APP, "development");

beforeEach(async () => {
  await setProfile("github.com/test/project", {
    workspaceId: "",
    appId: MOCK_APP.application_id,
    instances: { development: devInstance.instance_id },
  });

  installFetchMock({
    [`/applications/${MOCK_APP.application_id}`]: MOCK_APP,
  });
});

test("preserves existing non-Clerk vars and appends Clerk section", async () => {
  // Write a package.json (Express) so framework detection finds a match
  await Bun.write(
    join(h.tempDir, "package.json"),
    JSON.stringify({ name: "test", dependencies: { express: "4.21.0" } }),
  );

  // Write an existing .env.local with non-Clerk vars
  const existing = "DATABASE_URL=postgres://localhost/mydb\nREDIS_URL=redis://localhost\n";
  await Bun.write(join(h.tempDir, ".env.local"), existing);

  await clerk("--mode", "human", "env", "pull");

  const content = await Bun.file(join(h.tempDir, ".env.local")).text();
  const env = parseEnvFile(content, ".env.local");

  // Non-Clerk vars preserved
  expect(env.get("DATABASE_URL")).toBe("postgres://localhost/mydb");
  expect(env.get("REDIS_URL")).toBe("redis://localhost");

  // Clerk vars appended
  expect(env.get("CLERK_PUBLISHABLE_KEY")).toBe(devInstance.publishable_key);
  expect(env.get("CLERK_SECRET_KEY")).toBe(devInstance.secret_key);

  // Clerk section header present
  expect(content).toContain("# Clerk");
});

test("updates stale Clerk keys in-place without duplicates", async () => {
  await Bun.write(
    join(h.tempDir, "package.json"),
    JSON.stringify({ name: "test", dependencies: { next: "15.0.0" } }),
  );

  // Write .env.local with stale Clerk keys
  const stale =
    "NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=pk_test_old\nCLERK_SECRET_KEY=sk_test_old\nOTHER_VAR=keep\n";
  await Bun.write(join(h.tempDir, ".env.local"), stale);

  await clerk("--mode", "human", "env", "pull");

  const content = await Bun.file(join(h.tempDir, ".env.local")).text();
  const env = parseEnvFile(content, ".env.local");

  // Keys updated to new values
  expect(env.get("NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY")).toBe(devInstance.publishable_key);
  expect(env.get("CLERK_SECRET_KEY")).toBe(devInstance.secret_key);

  // Other vars preserved
  expect(env.get("OTHER_VAR")).toBe("keep");

  // No "# Clerk" header since keys already existed (updated in-place)
  expect(content).not.toContain("# Clerk");
});

test("--file flag writes to specified file instead of .env.local", async () => {
  await Bun.write(
    join(h.tempDir, "package.json"),
    JSON.stringify({ name: "test", dependencies: { express: "4.21.0" } }),
  );

  await clerk("--mode", "human", "env", "pull", "--file", ".env.development");

  // Specified file has Clerk vars
  const content = await Bun.file(join(h.tempDir, ".env.development")).text();
  const env = parseEnvFile(content, ".env.development");
  expect(env.get("CLERK_PUBLISHABLE_KEY")).toBe(devInstance.publishable_key);
  expect(env.get("CLERK_SECRET_KEY")).toBe(devInstance.secret_key);

  // .env.local was NOT created
  const envLocalExists = await Bun.file(join(h.tempDir, ".env.local")).exists();
  expect(envLocalExists).toBe(false);
});

test("falls back to .env when it exists and .env.local does not", async () => {
  await Bun.write(
    join(h.tempDir, "package.json"),
    JSON.stringify({ name: "test", dependencies: { express: "4.21.0" } }),
  );

  // Only .env exists (no .env.local)
  await Bun.write(join(h.tempDir, ".env"), "EXISTING=value\n");

  await clerk("--mode", "human", "env", "pull");

  // Should write to .env (existing file)
  const content = await Bun.file(join(h.tempDir, ".env")).text();
  const env = parseEnvFile(content, ".env");
  expect(env.get("EXISTING")).toBe("value");
  expect(env.get("CLERK_PUBLISHABLE_KEY")).toBe(devInstance.publishable_key);

  // .env.local was NOT created
  const envLocalExists = await Bun.file(join(h.tempDir, ".env.local")).exists();
  expect(envLocalExists).toBe(false);
});
