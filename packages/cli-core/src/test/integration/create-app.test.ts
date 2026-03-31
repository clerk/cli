/**
 * Create-app flow
 * Tests `clerk link --create-app` which creates a new application via POST
 * and then fetches it to populate the profile.
 */

import { test, expect } from "bun:test";
import { useIntegrationTestHarness, http, readConfig, clerk, MOCK_APP } from "../lib/setup.ts";
import type { Application } from "../../lib/plapi.ts";

useIntegrationTestHarness();

/** Minimal response from POST /v1/platform/applications (no secret keys). */
const CREATED_APP: Application = {
  application_id: MOCK_APP.application_id,
  name: "My App",
  instances: [],
};

test("link --create-app posts to /applications and stores profile", async () => {
  const requests: Array<{ method: string; url: string; body: string | null }> = [];

  http.stub(async (url, init) => {
    const method = init?.method ?? "GET";
    const body = (init?.body as string) ?? null;
    requests.push({ method, url, body });

    // POST /v1/platform/applications — create
    if (method === "POST" && url.includes("/v1/platform/applications")) {
      return new Response(JSON.stringify(CREATED_APP), { status: 200 });
    }

    // GET /v1/platform/applications/<id> — fetch with secret keys
    if (method === "GET" && url.includes(`/applications/${MOCK_APP.application_id}`)) {
      return new Response(JSON.stringify(MOCK_APP), { status: 200 });
    }

    throw new Error(`Unexpected request: ${method} ${url}`);
  });

  await clerk("--mode", "human", "link", "--create-app", "My App");

  // Verify the POST was made with the correct body
  const postReq = requests.find((r) => r.method === "POST");
  expect(postReq).toBeDefined();
  expect(postReq!.url).toContain("/v1/platform/applications");
  expect(JSON.parse(postReq!.body!)).toEqual({ name: "My App" });

  // Verify a follow-up GET fetched the full application
  const getReq = requests.find(
    (r) => r.method === "GET" && r.url.includes(`/applications/${MOCK_APP.application_id}`),
  );
  expect(getReq).toBeDefined();

  // Verify config was written
  const config = await readConfig();
  const profile = config.profiles["github.com/test/project"];
  expect(profile).toBeDefined();
  expect(profile!.appId).toBe(MOCK_APP.application_id);
  expect(profile!.appName).toBe(MOCK_APP.name);
});
