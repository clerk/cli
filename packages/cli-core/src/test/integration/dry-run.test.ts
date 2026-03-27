/**
 * Dry-run previews before committing changes
 * Preview destructive operations safely.
 */

import { test, expect, beforeEach } from "bun:test";
import {
  useIntegrationTestHarness,
  http,
  setProfile,
  clerk,
  getInstance,
  MOCK_APP,
} from "../lib/setup.ts";

useIntegrationTestHarness();

const devInstance = getInstance(MOCK_APP, "development");

beforeEach(async () => {
  await setProfile("github.com/test/project", {
    workspaceId: "",
    appId: MOCK_APP.application_id,
    instances: { development: devInstance.instance_id },
  });
});

test.each([{ mode: "human" }, { mode: "agent" }])(
  "api dry-run sends no requests ($mode mode)",
  async ({ mode }) => {
    const { stderr } = await clerk(
      "--mode",
      mode,
      "api",
      "/users",
      "--secret-key",
      devInstance.secret_key!,
      "-d",
      '{"email_address":["test@x.com"]}',
      "--dry-run",
    );
    expect(http.requests.length).toBe(0);
    expect(stderr).toContain("[dry-run] POST");
  },
);

test.each([{ mode: "human" }, { mode: "agent" }])(
  "config patch dry-run sends no requests ($mode mode)",
  async ({ mode }) => {
    const { stdout, stderr } = await clerk(
      "--mode",
      mode,
      "config",
      "patch",
      "--json",
      '{"session":{"lifetime":3600}}',
      "--dry-run",
    );
    expect(http.requests.length).toBe(0);
    expect(stderr).toContain("[dry-run]");
    expect(stdout).toContain('"lifetime": 3600');
  },
);

test.each([{ mode: "human" }, { mode: "agent" }])(
  "config patch without dry-run sends PATCH ($mode mode)",
  async ({ mode }) => {
    const updatedConfig = { session: { lifetime: 3600 } };
    // GET returns different config so hasConfigChanges detects changes
    http.stub(async (_url, init) => {
      const body = init?.method ? updatedConfig : { session: { lifetime: 604800 } };
      return new Response(JSON.stringify(body), { status: 200 });
    });

    await clerk(
      "--mode",
      mode,
      "config",
      "patch",
      "--json",
      '{"session":{"lifetime":3600}}',
      "--yes",
    );
    const patchReqs = http.requests.filter((r) => r.method === "PATCH");
    expect(patchReqs.length).toBe(1);
  },
);
