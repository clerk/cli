/**
 * Switch project between Clerk apps
 * Re-link from one app to another.
 */

// TODO: Add agent mode coverage once `link` and `unlink` perform actual work
// in agent mode. Currently both commands only print prompts without modifying
// config, so the switch-apps flow cannot be tested in agent mode.

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
  MOCK_APP_B,
} from "./lib/harness.ts";

const h = useIntegrationTestHarness();

test("re-link from one app to another", async () => {
  await Bun.write(
    join(h.tempDir, "package.json"),
    JSON.stringify({ name: "test", dependencies: { next: "15.0.0" } }),
  );

  const appADev = getInstance(MOCK_APP, "development");
  const appBDev = getInstance(MOCK_APP_B, "development");

  // Link to App A
  http.mock({
    [`/applications/${MOCK_APP.application_id}`]: MOCK_APP,
  });
  await clerk("--mode", "human", "link", "--app", MOCK_APP.application_id);

  let config = await readConfig();
  expect(config.profiles["github.com/test/project"]!.appId).toBe(MOCK_APP.application_id);

  // Pull env for App A
  await clerk("--mode", "human", "env", "pull");
  let env = parseEnvFile(await Bun.file(join(h.tempDir, ".env.local")).text(), ".env.local");
  expect(env.get("NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY")).toBe(appADev.publishable_key);

  // Unlink
  await clerk("--mode", "human", "unlink", "--yes");
  config = await readConfig();
  expect(config.profiles["github.com/test/project"]).toBeUndefined();

  // Link to App B
  http.mock({
    [`/applications/${MOCK_APP_B.application_id}`]: MOCK_APP_B,
  });
  await clerk("--mode", "human", "link", "--app", MOCK_APP_B.application_id);

  config = await readConfig();
  expect(config.profiles["github.com/test/project"]!.appId).toBe(MOCK_APP_B.application_id);

  // Pull env for App B — should overwrite App A's values, not append
  await clerk("--mode", "human", "env", "pull");
  env = parseEnvFile(await Bun.file(join(h.tempDir, ".env.local")).text(), ".env.local");
  expect(env.get("NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY")).toBe(appBDev.publishable_key);
  expect(env.get("CLERK_SECRET_KEY")).toBe(appBDev.secret_key);
});
