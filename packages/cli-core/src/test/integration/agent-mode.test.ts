/**
 * Agent mode provides actionable instructions
 * AI agents get structured prompts instead of interactive flows.
 */

import { test, expect } from "bun:test";
import { join } from "node:path";
import {
  useIntegrationTestHarness,
  http,
  clerk,
  getInstance,
  parseEnvFile,
  MOCK_APP,
} from "../lib/setup.ts";

const h = useIntegrationTestHarness();

test("init outputs structured agent prompt without API calls", async () => {
  const { stdout } = await clerk("--mode", "agent", "init");
  expect(stdout).toContain("clerk init -y");
  expect(http.requests.length).toBe(0);
});

test("link outputs structured agent prompt without API calls", async () => {
  const { stdout } = await clerk("--mode", "agent", "link");
  expect(stdout).toContain("linking a Clerk application");
  expect(stdout).toContain("## Steps");
  expect(http.requests.length).toBe(0);
});

test("unlink outputs structured agent prompt without API calls", async () => {
  const { stdout } = await clerk("--mode", "agent", "unlink");
  expect(stdout).toContain("unlinking a Clerk application");
  expect(stdout).toContain("## Steps");
  expect(http.requests.length).toBe(0);
});

test("init --app in agent mode scaffolds instead of outputting prompt", async () => {
  // Write package.json so framework detection works and SDK install is skipped
  await Bun.write(
    join(h.tempDir, "package.json"),
    JSON.stringify({
      name: "test-project",
      dependencies: { next: "15.0.0", "@clerk/nextjs": "6.0.0" },
    }),
  );

  http.mock({
    [`/applications/${MOCK_APP.application_id}`]: MOCK_APP,
  });

  const { stdout, stderr } = await clerk(
    "--mode",
    "agent",
    "init",
    "--app",
    MOCK_APP.application_id,
  );

  // Should NOT output the agent prompt — it should actually scaffold
  expect(stdout).not.toContain("# Add Clerk Authentication");
  // Should pull env vars (this is part of the scaffold flow)
  expect(stderr).toContain("Pulling env vars");
});

test("init --app --instance prod uses production keys in .env", async () => {
  const prodInstance = getInstance(MOCK_APP, "production");

  await Bun.write(
    join(h.tempDir, "package.json"),
    JSON.stringify({
      name: "test-project",
      dependencies: { next: "15.0.0", "@clerk/nextjs": "6.0.0" },
    }),
  );

  http.mock({
    [`/applications/${MOCK_APP.application_id}`]: MOCK_APP,
  });

  await clerk("--mode", "agent", "init", "--app", MOCK_APP.application_id, "--instance", "prod");

  const envContent = await Bun.file(join(h.tempDir, ".env")).text();
  const env = parseEnvFile(envContent, ".env");
  expect(env.get("NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY")).toBe(prodInstance.publishable_key);
  expect(env.get("CLERK_SECRET_KEY")).toBe(prodInstance.secret_key);
});

test("init --app in human mode skips login/link", async () => {
  await Bun.write(
    join(h.tempDir, "package.json"),
    JSON.stringify({
      name: "test-project",
      dependencies: { next: "15.0.0", "@clerk/nextjs": "6.0.0" },
    }),
  );

  http.mock({
    [`/applications/${MOCK_APP.application_id}`]: MOCK_APP,
  });

  const { stdout } = await clerk("--mode", "human", "init", "--app", MOCK_APP.application_id);

  // Should NOT show "Logged in as" since --app skips authenticateAndLink
  expect(stdout).not.toContain("Logged in as");
});
