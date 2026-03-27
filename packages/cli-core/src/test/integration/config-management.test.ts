/**
 * Inspect and update instance configuration
 * Review config, check schema, patch settings.
 */

import { test, expect } from "bun:test";
import {
  useIntegrationTestHarness,
  http,
  setProfile,
  clerk,
  getInstance,
  MOCK_APP,
  MOCK_CONFIG,
  MOCK_SCHEMA,
} from "../lib/setup.ts";

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

    http.mock({
      "/config": MOCK_CONFIG,
    });

    // Pull config
    const { stdout: pullOutput } = await clerk("--mode", mode, "config", "pull");
    expect(pullOutput).toContain(`"lifetime": ${MOCK_CONFIG.session.lifetime}`);

    // Pull schema
    http.mock({
      "/config/schema": MOCK_SCHEMA,
    });

    const { stdout: schemaOutput } = await clerk("--mode", mode, "config", "schema");
    expect(schemaOutput).toContain(`"type": "${MOCK_SCHEMA.type}"`);

    // Patch config — GET returns current (different) config so changes are detected
    const updatedConfig = { session: { lifetime: 86400 }, sign_up: { mode: "public" } };
    http.stub(async (_url, init) => {
      const body = init?.method ? updatedConfig : MOCK_CONFIG;
      return new Response(JSON.stringify(body), { status: 200 });
    });

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
    const patchReqs = http.requests.filter((r) => r.method === "PATCH");
    expect(patchReqs.length).toBe(1);
    expect(JSON.parse(patchReqs[0]!.body!)).toEqual({ session: { lifetime: 86400 } });

    // Verify all API URLs used correct instance ID
    const instanceCalls = http.requests.filter((r) => r.url.includes("/instances/"));
    for (const call of instanceCalls) {
      expect(call.url).toContain(devInstance.instance_id);
    }
  },
);
