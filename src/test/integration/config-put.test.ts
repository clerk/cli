/**
 * Config put (full replacement)
 * Tests `config put` which replaces the entire instance configuration,
 * distinct from `config patch` which partially updates it.
 */

import { test, expect, beforeEach } from "bun:test";
import {
  useIntegrationTestHarness,
  installFetchMock,
  requests,
  mockPrompts,
  setProfile,
  clerk,
  getInstance,
  MOCK_APP,
  MOCK_CONFIG,
} from "./setup.ts";

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
  "config put sends PUT request with full config ($mode mode)",
  async ({ mode }) => {
    const fullConfig = {
      session: { lifetime: 86400 },
      sign_up: { mode: "restricted" },
      sign_in: { enabled: true },
    };

    installFetchMock({
      "/config": fullConfig,
    });

    await clerk("--mode", mode, "config", "put", "--json", JSON.stringify(fullConfig), "--yes");

    // Verify PUT (not PATCH) request was sent
    const putReqs = requests.filter((r) => r.method === "PUT");
    expect(putReqs.length).toBe(1);
    expect(JSON.parse(putReqs[0]!.body!)).toEqual(fullConfig);

    // Verify no PATCH requests were sent
    const patchReqs = requests.filter((r) => r.method === "PATCH");
    expect(patchReqs.length).toBe(0);

    // Verify correct instance ID in URL
    expect(putReqs[0]!.url).toContain(devInstance.instance_id);
  },
);

test("config put requires confirmation in human mode without --yes", async () => {
  const fullConfig = { session: { lifetime: 3600 } };

  installFetchMock({
    "/config": fullConfig,
  });

  // Queue a "yes" confirmation response
  mockPrompts.confirm(true);

  await clerk("--mode", "human", "config", "put", "--json", JSON.stringify(fullConfig));

  const putReqs = requests.filter((r) => r.method === "PUT");
  expect(putReqs.length).toBe(1);
});

test("config put aborted when user declines confirmation", async () => {
  installFetchMock({
    "/config": MOCK_CONFIG,
  });

  // Queue a "no" confirmation
  mockPrompts.confirm(false);

  const result = await clerk.raw(
    "--mode",
    "human",
    "config",
    "put",
    "--json",
    '{"session":{"lifetime":3600}}',
  );

  expect(result.exitCode).toBe(0);

  // No PUT request sent
  const putReqs = requests.filter((r) => r.method === "PUT");
  expect(putReqs.length).toBe(0);
});

test("config put --dry-run shows payload without sending request", async () => {
  installFetchMock();

  const { stdout, stderr } = await clerk(
    "--mode",
    "human",
    "config",
    "put",
    "--json",
    '{"session":{"lifetime":3600}}',
    "--dry-run",
  );

  expect(stderr).toContain("[dry-run]");
  expect(stdout).toContain('"lifetime": 3600');

  // No requests sent
  expect(requests.length).toBe(0);
});
