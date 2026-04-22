/**
 * Config put (full replacement)
 * Tests `config put` which replaces the entire instance configuration,
 * distinct from `config patch` which partially updates it.
 */

import { test, expect, beforeEach } from "bun:test";
import {
  useIntegrationTestHarness,
  http,
  mockPrompts,
  setProfile,
  clerk,
  getInstance,
  MOCK_APP,
} from "./lib/harness.ts";

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

    // GET returns a different config so hasConfigChanges detects changes
    http.stub(async (_url, init) => {
      const body =
        init?.method && init.method !== "GET" ? fullConfig : { session: { lifetime: 3600 } };
      return new Response(JSON.stringify(body), { status: 200 });
    });

    await clerk("--mode", mode, "config", "put", "--json", JSON.stringify(fullConfig), "--yes");

    // Verify PUT (not PATCH) request was sent
    const putReqs = http.requests.filter((r) => r.method === "PUT");
    expect(putReqs.length).toBe(1);
    expect(JSON.parse(putReqs[0]!.body!)).toEqual(fullConfig);

    // Verify no PATCH requests were sent
    const patchReqs = http.requests.filter((r) => r.method === "PATCH");
    expect(patchReqs.length).toBe(0);

    // Verify correct instance ID in URL
    expect(putReqs[0]!.url).toContain(devInstance.instance_id);
  },
);

test("config put requires confirmation in human mode without --yes", async () => {
  const fullConfig = { session: { lifetime: 3600 } };

  // GET returns different config so changes are detected
  http.stub(async (_url, init) => {
    const body =
      init?.method && init.method !== "GET" ? fullConfig : { session: { lifetime: 604800 } };
    return new Response(JSON.stringify(body), { status: 200 });
  });

  // Queue a "yes" confirmation response
  mockPrompts.confirm(true);

  await clerk("--mode", "human", "config", "put", "--json", JSON.stringify(fullConfig));

  const putReqs = http.requests.filter((r) => r.method === "PUT");
  expect(putReqs.length).toBe(1);
});

test("config put aborted when user declines confirmation", async () => {
  // Mock the current config endpoint (needed for the diff preview)
  http.mock({
    "/config": { session: { lifetime: 604800 } },
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
  const putReqs = http.requests.filter((r) => r.method === "PUT");
  expect(putReqs.length).toBe(0);
});

test("config put --dry-run sends PUT with ?dry_run=true and shows projected result", async () => {
  http.stub(async (_url, init) => {
    const body =
      init?.method && init.method !== "GET"
        ? { session: { lifetime: 3600 } }
        : { session: { lifetime: 604800 } };
    return new Response(JSON.stringify(body), { status: 200 });
  });

  const { stderr } = await clerk(
    "--mode",
    "human",
    "config",
    "put",
    "--json",
    '{"session":{"lifetime":3600}}',
    "--dry-run",
  );

  expect(stderr).toContain("[dry-run]");
  expect(stderr).toContain("3600");

  const putReqs = http.requests.filter((r) => r.method === "PUT");
  expect(putReqs.length).toBe(1);
  expect(putReqs[0]!.url).toContain("dry_run=true");
});
