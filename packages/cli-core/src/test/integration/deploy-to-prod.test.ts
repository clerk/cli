/**
 * Deploy to production
 * Switch from dev to prod credentials.
 */

import { test, expect } from "bun:test";
import { join } from "node:path";
import {
  useIntegrationTestHarness,
  http,
  setProfile,
  parseEnvFile,
  clerk,
  getInstance,
  MOCK_APP,
} from "./lib/harness.ts";

const h = useIntegrationTestHarness();

test.each([{ mode: "human" }, { mode: "agent" }])(
  "switch from dev to prod credentials ($mode mode)",
  async ({ mode }) => {
    const devInstance = getInstance(MOCK_APP, "development");
    const prodInstance = getInstance(MOCK_APP, "production");

    await setProfile("github.com/test/project", {
      workspaceId: "",
      appId: MOCK_APP.application_id,
      instances: { development: devInstance.instance_id, production: prodInstance.instance_id },
    });
    await Bun.write(
      join(h.tempDir, "package.json"),
      JSON.stringify({ name: "test", dependencies: { next: "15.0.0" } }),
    );

    http.mock({
      [`/applications/${MOCK_APP.application_id}`]: MOCK_APP,
    });

    // Pull dev env (default)
    await clerk("--mode", mode, "env", "pull");
    const devEnv = parseEnvFile(await Bun.file(join(h.tempDir, ".env.local")).text(), ".env.local");
    expect(devEnv.get("NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY")).toBe(devInstance.publishable_key);
    expect(devEnv.get("CLERK_SECRET_KEY")).toBe(devInstance.secret_key);

    // Pull prod env to separate file
    await clerk("--mode", mode, "env", "pull", "--instance", "prod", "--file", ".env.production");
    const prodEnv = parseEnvFile(
      await Bun.file(join(h.tempDir, ".env.production")).text(),
      ".env.production",
    );
    expect(prodEnv.get("NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY")).toBe(prodInstance.publishable_key);
    expect(prodEnv.get("CLERK_SECRET_KEY")).toBe(prodInstance.secret_key);

    // Dev file not overwritten
    const devEnvAfter = parseEnvFile(
      await Bun.file(join(h.tempDir, ".env.local")).text(),
      ".env.local",
    );
    expect(devEnvAfter.get("NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY")).toBe(devInstance.publishable_key);

    // Config pull targets prod instance
    await clerk("--mode", mode, "config", "pull", "--instance", "prod");
    const configCalls = http.requests.filter(
      (r) =>
        r.url.includes(`/instances/${prodInstance.instance_id}/config`) &&
        !r.url.includes("schema"),
    );
    expect(configCalls.length).toBe(1);
  },
);
