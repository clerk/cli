/**
 * Switch project between Clerk apps
 * Re-link from one app to another.
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
  MOCK_APP_B,
} from "./lib/harness.ts";

const h = useIntegrationTestHarness();
const MODES = ["human", "agent"] as const;

test.each([...MODES])("re-link from one app to another (%s)", async (mode) => {
  await Bun.write(
    join(h.tempDir, "package.json"),
    JSON.stringify({ name: "test", dependencies: { next: "15.0.0" } }),
  );

  const appADev = getInstance(MOCK_APP, "development");
  const appBDev = getInstance(MOCK_APP_B, "development");

  http.mock({
    [`/applications/${MOCK_APP.application_id}`]: MOCK_APP,
  });
  await clerk("--mode", mode, "link", "--app", MOCK_APP.application_id);

  let config = await readConfig();
  expect(config.profiles["github.com/test/project"]!.appId).toBe(MOCK_APP.application_id);

  await clerk("--mode", mode, "env", "pull");
  let env = parseEnvFile(await Bun.file(join(h.tempDir, ".env.local")).text(), ".env.local");
  expect(env.get("NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY")).toBe(appADev.publishable_key);

  await clerk("--mode", mode, "unlink", "--yes");
  config = await readConfig();
  expect(config.profiles["github.com/test/project"]).toBeUndefined();

  http.mock({
    [`/applications/${MOCK_APP_B.application_id}`]: MOCK_APP_B,
  });
  await clerk("--mode", mode, "link", "--app", MOCK_APP_B.application_id);

  config = await readConfig();
  expect(config.profiles["github.com/test/project"]!.appId).toBe(MOCK_APP_B.application_id);

  await clerk("--mode", mode, "env", "pull");
  env = parseEnvFile(await Bun.file(join(h.tempDir, ".env.local")).text(), ".env.local");
  expect(env.get("NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY")).toBe(appBDev.publishable_key);
  expect(env.get("CLERK_SECRET_KEY")).toBe(appBDev.secret_key);
});
