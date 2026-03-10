/**
 * Inspect and update instance configuration
 * Review config, check schema, patch settings.
 */

import { test, expect } from "bun:test";
import {
  useIntegrationTestHarness,
  installFetchMock,
  requests,
  setProfile,
  clerk,
  getInstance,
  MOCK_APP,
  MOCK_CONFIG,
  MOCK_SCHEMA,
} from "./setup.ts";

useIntegrationTestHarness();

test.each([{ mode: "human" }, { mode: "agent" }])(
  "pull config, check schema, patch settings ($mode mode)",
  async ({ mode }) => {
    const devInstance = getInstance(MOCK_APP, "development");

    await setProfile("github.com/test/project", {
      workspaceId: "",
      appId: MOCK_APP.application_id,
      instances: { development: devInstance.instance_id },
    });

    const updatedConfig = { session: { lifetime: 86400 }, sign_up: { mode: "public" } };

    installFetchMock({
      "/config/schema": MOCK_SCHEMA,
      "/config": MOCK_CONFIG,
    });

    // Pull config
    const { stdout: pullOutput } = await clerk("--mode", mode, "config", "pull");
    expect(pullOutput).toContain(`"lifetime": ${MOCK_CONFIG.session.lifetime}`);

    // Pull schema
    installFetchMock({
      "/config/schema": MOCK_SCHEMA,
      "/config": updatedConfig,
    });

    const { stdout: schemaOutput } = await clerk("--mode", mode, "config", "schema");
    expect(schemaOutput).toContain(`"type": "${MOCK_SCHEMA.type}"`);

    // Patch config
    await clerk(
      "--mode",
      mode,
      "config",
      "patch",
      "--json",
      '{"session":{"lifetime":86400}}',
      "--yes",
    );

    // Verify PATCH request was sent
    const patchReqs = requests.filter((r) => r.method === "PATCH");
    expect(patchReqs.length).toBeGreaterThan(0);
    expect(JSON.parse(patchReqs[0]!.body!)).toEqual({ session: { lifetime: 86400 } });

    // Verify all API URLs used correct instance ID
    const instanceCalls = requests.filter((r) => r.url.includes("/instances/"));
    for (const call of instanceCalls) {
      expect(call.url).toContain(devInstance.instance_id);
    }
  },
);
