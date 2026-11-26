/**
 * `clerk agents mcp configure` end to end through the real program, against a
 * stubbed Platform API that keeps an instance's OAuth settings and resources.
 */

import { test, expect, beforeEach, describe } from "bun:test";
import { useIntegrationTestHarness, http, setProfile, clerk, MOCK_APP } from "./lib/harness.ts";

useIntegrationTestHarness();

const SERVER_URL = "https://mcp.example.com/mcp";

interface Resource {
  id: string;
  uri: string;
  name: string;
  mcp_server: boolean;
  scopes: string[];
  oauth_application_id: string | null;
  reserved_oauth_application_id: string | null;
}

const OFF_SETTINGS = {
  aud_claim_enabled: false,
  client_id_metadata_documents_advertised: false,
  dynamic_oauth_client_registration: false,
  pkce_required: false,
};

let settings: Record<string, unknown>;
let resources: Resource[];
let application: typeof MOCK_APP;
/** What the MCP server answers at its protected resource metadata URL. */
let metadata: () => Response;

function resource(overrides: Partial<Resource> & { uri: string }): Resource {
  return {
    id: `oauthres_${resources.length + 1}`,
    name: "mcp.example.com/mcp",
    mcp_server: true,
    scopes: [],
    oauth_application_id: null,
    reserved_oauth_application_id: null,
    ...overrides,
  };
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status });
}

function servePlapi() {
  http.stub(async (url, init) => {
    const { pathname } = new URL(url);
    const method = init?.method ?? "GET";
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    const instance =
      /^\/v1\/platform\/applications\/app_1\/instances\/(ins_dev|ins_prod)\/(.+)$/.exec(pathname);

    if (pathname === "/v1/platform/applications/app_1" && method === "GET")
      return json(application);
    if (new URL(url).host === "mcp.example.com") return metadata();
    if (instance?.[2] === "oauth_application_settings") {
      if (method === "PATCH") settings = { ...settings, ...body };
      return json(settings);
    }
    if (instance?.[2] === "oauth_resources" && method === "GET") {
      return json({ data: resources, total_count: resources.length });
    }
    if (instance?.[2] === "oauth_resources" && method === "POST") {
      const created = resource({ ...body, id: "oauthres_new" });
      resources.push(created);
      return json(created);
    }
    const marked = /^oauth_resources\/(.+)$/.exec(instance?.[2] ?? "");
    if (marked && method === "PATCH") {
      const target = resources.find((r) => r.id === marked[1])!;
      Object.assign(target, body);
      return json(target);
    }
    return json({ errors: [{ message: "not found", code: "resource_not_found" }] }, 404);
  });
}

function sent(method: string, path: string) {
  return http.requests.filter((r) => r.method === method && new URL(r.url).pathname.endsWith(path));
}

beforeEach(async () => {
  settings = { ...OFF_SETTINGS };
  resources = [];
  application = MOCK_APP;
  metadata = () => json({ errors: [{ message: "not found" }] }, 404);
  await setProfile("github.com/test/project", {
    workspaceId: "",
    appId: MOCK_APP.application_id,
    instances: { development: "ins_dev", production: "ins_prod" },
  });
  servePlapi();
});

test("configure registers the first server after enabling the two instance settings", async () => {
  const { stdout } = await clerk("--mode", "agent", "agents", "mcp", "configure", SERVER_URL);

  const patches = sent("PATCH", "/instances/ins_dev/oauth_application_settings");
  expect(patches).toHaveLength(1);
  expect(JSON.parse(patches[0]!.body!)).toEqual({
    aud_claim_enabled: true,
    client_id_metadata_documents_advertised: true,
  });
  const posts = sent("POST", "/instances/ins_dev/oauth_resources");
  expect(posts).toHaveLength(1);
  expect(JSON.parse(posts[0]!.body!)).toEqual({
    uri: SERVER_URL,
    name: "mcp.example.com/mcp",
    mcp_server: true,
  });
  // Settings are saved before the resource, so a failed create is safe to retry.
  expect(http.requests.indexOf(patches[0]!)).toBeLessThan(http.requests.indexOf(posts[0]!));

  const result = JSON.parse(stdout);
  expect(result).toMatchObject({
    application_id: "app_1",
    instance_id: "ins_dev",
    resource_url: SERVER_URL,
    mcp_server: { id: "oauthres_new", uri: SERVER_URL, name: "mcp.example.com/mcp" },
    configuration: {
      status: "created",
      enabled_settings: ["client_id_metadata_documents_advertised", "aud_claim_enabled"],
      blockers: [],
    },
  });
});

test("configure leaves instance settings alone for a second server", async () => {
  resources = [
    resource({
      id: "oauthres_first",
      uri: "https://other.example.com/mcp",
      name: "other.example.com/mcp",
    }),
  ];

  const { stdout } = await clerk("--mode", "agent", "agents", "mcp", "configure", SERVER_URL);

  expect(sent("PATCH", "/oauth_application_settings")).toHaveLength(0);
  expect(sent("POST", "/oauth_resources")).toHaveLength(1);
  const result = JSON.parse(stdout);
  expect(result.configuration.status).toBe("created");
  expect(result.configuration.enabled_settings).toEqual([]);
  expect(result.configuration.blockers.map((b: { setting: string }) => b.setting)).toEqual([
    "aud_claim_enabled",
    "client_id_metadata_documents_advertised",
  ]);
});

test("configure counts a legacy Dashboard registration as an existing server", async () => {
  resources = [
    resource({
      id: "oauthres_legacy",
      uri: "https://other.example.com/mcp",
      name: "other.example.com/mcp",
      mcp_server: false,
    }),
  ];

  const { stdout } = await clerk("--mode", "agent", "agents", "mcp", "configure", SERVER_URL);

  expect(sent("PATCH", "/oauth_application_settings")).toHaveLength(0);
  expect(sent("POST", "/oauth_resources")).toHaveLength(1);
  expect(JSON.parse(stdout).configuration).toMatchObject({
    status: "created",
    enabled_settings: [],
  });
});

test("configure turns on only the first-server switches that are off", async () => {
  settings = { ...OFF_SETTINGS, aud_claim_enabled: true };

  await clerk("--mode", "agent", "agents", "mcp", "configure", SERVER_URL);

  const patches = sent("PATCH", "/oauth_application_settings");
  expect(patches.map((p) => JSON.parse(p.body!))).toEqual([
    { client_id_metadata_documents_advertised: true },
  ]);
});

test("configure changes nothing when the URL is already a registered MCP server", async () => {
  resources = [resource({ id: "oauthres_mcp", uri: "https://MCP.example.com:443/mcp" })];

  const { stdout } = await clerk("--mode", "agent", "agents", "mcp", "configure", SERVER_URL);

  expect(http.requests.filter((r) => r.method !== "GET")).toHaveLength(0);
  const result = JSON.parse(stdout);
  expect(result.configuration.status).toBe("unchanged");
  expect(result.mcp_server.id).toBe("oauthres_mcp");
});

test("configure marks a legacy Dashboard registration of the URL as an MCP server", async () => {
  resources = [resource({ id: "oauthres_legacy", uri: SERVER_URL, mcp_server: false })];

  const { stdout } = await clerk("--mode", "agent", "agents", "mcp", "configure", SERVER_URL);

  const marks = sent("PATCH", "/oauth_resources/oauthres_legacy");
  expect(marks.map((m) => JSON.parse(m.body!))).toEqual([{ mcp_server: true }]);
  expect(sent("POST", "/oauth_resources")).toHaveLength(0);
  // A legacy registration is not yet a marked server, so this is still the first one.
  expect(sent("PATCH", "/oauth_application_settings")).toHaveLength(1);
  expect(JSON.parse(stdout).configuration.status).toBe("marked");
});

test("configure refuses a URL another OAuth resource holds, before any write", async () => {
  resources = [
    resource({
      id: "oauthres_api",
      uri: SERVER_URL,
      name: "My API",
      mcp_server: false,
      scopes: ["read"],
    }),
  ];

  const result = await clerk.raw("--mode", "agent", "agents", "mcp", "configure", SERVER_URL);

  expect(result.exitCode).toBe(1);
  expect(JSON.parse(result.stderr).error.code).toBe("oauth_resource_conflict");
  expect(http.requests.filter((r) => r.method !== "GET")).toHaveLength(0);
});

test.each([
  { url: "http://mcp.example.com/mcp", problem: "must use https" },
  { url: "https://mcp.example.com/mcp#tools", problem: "must not contain a fragment" },
  { url: "https://user:pass@mcp.example.com/mcp", problem: "must not contain credentials" },
  { url: "mcp.example.com", problem: "must be an absolute URL" },
])("configure rejects $url without a request", async ({ url, problem }) => {
  const result = await clerk.raw("--mode", "agent", "agents", "mcp", "configure", url);

  expect(result.exitCode).toBe(2);
  expect(JSON.parse(result.stderr).error.message).toContain(problem);
  expect(http.requests).toHaveLength(0);
});

test.each([
  { flag: "prod", instance: "ins_prod" },
  { flag: "ins_prod", instance: "ins_prod" },
  { flag: "dev", instance: "ins_dev" },
])("configure --app app_1 --instance $flag targets $instance", async ({ flag, instance }) => {
  await setProfile("github.com/test/project", {
    workspaceId: "",
    appId: "app_other",
    instances: { development: "ins_other" },
  });

  const { stdout } = await clerk(
    "--mode",
    "agent",
    "agents",
    "mcp",
    "configure",
    SERVER_URL,
    "--app",
    "app_1",
    "--instance",
    flag,
  );

  expect(sent("POST", `/instances/${instance}/oauth_resources`)).toHaveLength(1);
  expect(JSON.parse(stdout)).toMatchObject({ application_id: "app_1", instance_id: instance });
});

test("configure --instance prod targets the linked production instance", async () => {
  await clerk("--mode", "agent", "agents", "mcp", "configure", SERVER_URL, "--instance", "prod");

  expect(sent("POST", "/instances/ins_prod/oauth_resources")).toHaveLength(1);
});

test("configure refuses an instance the application does not have", async () => {
  const result = await clerk.raw(
    "--mode",
    "agent",
    "agents",
    "mcp",
    "configure",
    SERVER_URL,
    "--app",
    "app_1",
    "--instance",
    "ins_missing",
  );

  expect(result.exitCode).toBe(1);
  expect(JSON.parse(result.stderr).error.code).toBe("instance_not_found");
  expect(http.requests.filter((r) => r.method !== "GET")).toHaveLength(0);
});

test("configure explains a legacy OAuth provider", async () => {
  http.stub(async (url) =>
    new URL(url).pathname === "/v1/platform/applications/app_1"
      ? json(MOCK_APP)
      : json({ errors: [{ message: "not enabled", code: "feature_not_enabled" }] }, 403),
  );

  const result = await clerk.raw("--mode", "agent", "agents", "mcp", "configure", SERVER_URL);

  expect(result.exitCode).toBe(1);
  const error = JSON.parse(result.stderr).error;
  expect(error.code).toBe("legacy_oauth_provider");
  expect(error.message).toContain("legacy OAuth provider");
});

test("configure in human mode reports the registration on stderr", async () => {
  const result = await clerk.raw("--mode", "human", "agents", "mcp", "configure", SERVER_URL);

  expect(result.exitCode).toBe(0);
  expect(result.stdout).toBe("");
  expect(result.stderr).toContain(`Registered ${SERVER_URL} as an MCP server`);
  expect(result.stderr).toContain(
    "Enabled OAuth settings: client_id_metadata_documents_advertised, aud_claim_enabled",
  );
  expect(result.stderr).toContain("/.well-known/oauth-protected-resource/mcp");
});

test("configure --json prints JSON in human mode", async () => {
  const { stdout } = await clerk(
    "--mode",
    "human",
    "agents",
    "mcp",
    "configure",
    SERVER_URL,
    "--json",
  );

  expect(JSON.parse(stdout).configuration.status).toBe("created");
});

test("configure reports the issuer from the instance's publishable key", async () => {
  const app = {
    ...MOCK_APP,
    instances: [
      { ...MOCK_APP.instances[0]!, publishable_key: `pk_test_${btoa("clerk.example.com$")}` },
    ],
  };
  const plapi = globalThis.fetch;
  http.stub(async (url, init) =>
    new URL(url).pathname === "/v1/platform/applications/app_1" ? json(app) : plapi(url, init),
  );

  const { stdout } = await clerk("--mode", "agent", "agents", "mcp", "configure", SERVER_URL);

  expect(JSON.parse(stdout).authorization_server).toEqual({
    issuer: "https://clerk.example.com",
    audience: SERVER_URL,
    protected_resource_metadata_url:
      "https://mcp.example.com/.well-known/oauth-protected-resource/mcp",
  });
});

describe("check", () => {
  const ISSUER = "https://clerk.example.com";
  const METADATA_URL = "https://mcp.example.com/.well-known/oauth-protected-resource/mcp";

  function statuses(stdout: string) {
    return Object.fromEntries(
      JSON.parse(stdout).checks.map((c: { name: string; status: string }) => [c.name, c.status]),
    );
  }

  beforeEach(() => {
    application = {
      ...MOCK_APP,
      instances: MOCK_APP.instances.map((instance) => ({
        ...instance,
        publishable_key: `pk_test_${btoa("clerk.example.com$")}`,
      })),
    };
    settings = {
      ...OFF_SETTINGS,
      aud_claim_enabled: true,
      client_id_metadata_documents_advertised: true,
    };
    resources = [resource({ id: "oauthres_mcp", uri: SERVER_URL })];
    metadata = () => json({ resource: SERVER_URL, authorization_servers: [ISSUER] });
  });

  test("check passes every check for a configured server and sends no MCP request", async () => {
    const { stdout } = await clerk("--mode", "agent", "agents", "mcp", "check", SERVER_URL);

    expect(statuses(stdout)).toEqual({
      resource_registered: "pass",
      aud_claim_enabled: "pass",
      client_registration: "pass",
      protected_resource_metadata: "pass",
    });
    expect(JSON.parse(stdout)).toMatchObject({
      application_id: "app_1",
      instance_id: "ins_dev",
      resource_url: SERVER_URL,
      passed: true,
      mcp_server: { id: "oauthres_mcp", uri: SERVER_URL },
    });
    expect(http.requests.filter((r) => r.method !== "GET")).toHaveLength(0);
    const toServer = http.requests.filter((r) => new URL(r.url).host === "mcp.example.com");
    expect(toServer.map((r) => r.url)).toEqual([METADATA_URL]);
  });

  test.each([
    {
      setting: "aud_claim_enabled",
      saved: { aud_claim_enabled: false },
      failed: "aud_claim_enabled",
    },
    {
      setting: "client registration",
      saved: { client_id_metadata_documents_advertised: false },
      failed: "client_registration",
    },
  ])("check fails $failed when $setting is off", async ({ saved, failed }) => {
    settings = { ...settings, ...saved };

    const result = await clerk.raw("--mode", "agent", "agents", "mcp", "check", SERVER_URL);

    expect(result.exitCode).toBe(1);
    expect(JSON.parse(result.stderr).error.code).toBe("mcp_check_failed");
    const checks = statuses(result.stdout);
    expect(checks[failed]).toBe("fail");
    expect(Object.values(checks).filter((s) => s === "fail")).toHaveLength(1);
    expect(JSON.parse(result.stdout).passed).toBe(false);
  });

  test("check reports client_registration as failed with CIMD and DCR both off", async () => {
    settings = { ...settings, client_id_metadata_documents_advertised: false };

    const result = await clerk.raw("--mode", "agent", "agents", "mcp", "check", SERVER_URL);

    const output = JSON.parse(result.stdout);
    const registration = output.checks.find(
      (c: { name: string }) => c.name === "client_registration",
    );
    expect(registration.message).toContain("client ID metadata documents");
    expect(registration.message).toContain("dynamic client registration");
    // The blockers key stays the setting name, as the connector reports it.
    expect(output.configuration.blockers.map((b: { setting: string }) => b.setting)).toEqual([
      "client_id_metadata_documents_advertised",
    ]);
  });

  test("check counts dynamic client registration as client registration", async () => {
    settings = {
      ...settings,
      client_id_metadata_documents_advertised: false,
      dynamic_oauth_client_registration: true,
    };

    const { stdout } = await clerk("--mode", "agent", "agents", "mcp", "check", SERVER_URL);

    expect(statuses(stdout).client_registration).toBe("pass");
  });

  test("check fails registration for a legacy Dashboard registration and says to run configure", async () => {
    resources = [resource({ id: "oauthres_legacy", uri: SERVER_URL, mcp_server: false })];

    const result = await clerk.raw("--mode", "agent", "agents", "mcp", "check", SERVER_URL);

    expect(result.exitCode).toBe(1);
    const output = JSON.parse(result.stdout);
    expect(output.configuration.status).toBe("migration_required");
    const registered = output.checks.find(
      (c: { name: string }) => c.name === "resource_registered",
    );
    expect(registered.status).toBe("fail");
    expect(registered.message).toContain(`clerk agents mcp configure ${SERVER_URL}`);
    expect(output.mcp_server).toBeNull();
  });

  test.each([
    { registered: "none", servers: () => [] },
    {
      registered: "https://other.example.com/mcp",
      servers: () => [resource({ id: "oauthres_other", uri: "https://other.example.com/mcp" })],
    },
  ])(
    "check refuses an unregistered URL before reading its metadata (registered: $registered)",
    async ({ registered, servers }) => {
      resources = servers();

      const result = await clerk.raw("--mode", "agent", "agents", "mcp", "check", SERVER_URL);

      expect(result.exitCode).toBe(1);
      expect(result.stdout).toBe("");
      const error = JSON.parse(result.stderr).error;
      expect(error.code).toBe("mcp_server_not_registered");
      expect(error.message).toBe(
        `${SERVER_URL} is not a registered MCP server URL on this instance. Registered: ${registered}.`,
      );
      expect(http.requests.filter((r) => new URL(r.url).host === "mcp.example.com")).toHaveLength(
        0,
      );
    },
  );

  test.each([
    { problem: "a 404", serve: () => json({}, 404), message: "HTTP 404" },
    {
      problem: "a non-JSON body",
      serve: () => new Response("<html>"),
      message: "did not return JSON",
    },
    {
      problem: "a different resource",
      serve: () => json({ resource: `${SERVER_URL}/`, authorization_servers: [ISSUER] }),
      message: "not identical",
    },
    {
      problem: "another authorization server",
      serve: () =>
        json({ resource: SERVER_URL, authorization_servers: ["https://auth.example.com"] }),
      message: `does not list ${ISSUER}`,
    },
    {
      problem: "a network error",
      serve: () => {
        throw new TypeError("connection refused");
      },
      message: "Could not reach",
    },
  ])("check fails protected_resource_metadata on $problem", async ({ serve, message }) => {
    metadata = serve;

    const result = await clerk.raw("--mode", "agent", "agents", "mcp", "check", SERVER_URL);

    expect(result.exitCode).toBe(1);
    const output = JSON.parse(result.stdout);
    const probe = output.checks.find(
      (c: { name: string }) => c.name === "protected_resource_metadata",
    );
    expect(probe.status).toBe("fail");
    expect(probe.message).toContain(message);
    expect(statuses(result.stdout).resource_registered).toBe("pass");
  });

  test("check fails protected_resource_metadata when the issuer can't be determined", async () => {
    application = MOCK_APP;

    const result = await clerk.raw("--mode", "agent", "agents", "mcp", "check", SERVER_URL);

    expect(result.exitCode).toBe(1);
    const probe = JSON.parse(result.stdout).checks.find(
      (c: { name: string }) => c.name === "protected_resource_metadata",
    );
    expect(probe).toEqual({
      name: "protected_resource_metadata",
      status: "fail",
      message: "This instance's issuer could not be determined.",
    });
    expect(http.requests.filter((r) => new URL(r.url).host === "mcp.example.com")).toHaveLength(0);
  });

  test("check without a URL checks the instance's only MCP server", async () => {
    const { stdout } = await clerk("--mode", "agent", "agents", "mcp", "check");

    expect(JSON.parse(stdout)).toMatchObject({ resource_url: SERVER_URL, passed: true });
  });

  test("check without a URL names the legacy registrations when no server is marked", async () => {
    const OTHER_URL = "https://other.example.com/mcp";
    resources = [
      resource({ id: "oauthres_legacy", uri: SERVER_URL, mcp_server: false }),
      resource({
        id: "oauthres_legacy_other",
        uri: OTHER_URL,
        name: "other.example.com/mcp",
        mcp_server: false,
      }),
    ];

    const result = await clerk.raw("--mode", "agent", "agents", "mcp", "check");

    expect(result.exitCode).toBe(1);
    const output = JSON.parse(result.stdout);
    expect(output.configuration.status).toBe("migration_required");
    expect(output.resource_url).toBeNull();
    const registered = output.checks.find(
      (c: { name: string }) => c.name === "resource_registered",
    );
    expect(registered.status).toBe("fail");
    expect(registered.message).not.toContain("No MCP server is registered");
    expect(registered.message).toContain(`${SERVER_URL}, ${OTHER_URL}`);
    expect(registered.message).toContain("clerk agents mcp configure <url>");
    const probe = output.checks.find(
      (c: { name: string }) => c.name === "protected_resource_metadata",
    );
    expect(probe.status).toBe("fail");
    expect(probe.message).not.toContain("No MCP server URL");
    expect(output.next_steps.join(" ")).toContain(`${SERVER_URL}, ${OTHER_URL}`);
    expect(http.requests.filter((r) => new URL(r.url).host === "mcp.example.com")).toHaveLength(0);
  });

  test("check without a URL refuses when several MCP servers are registered", async () => {
    resources.push(resource({ id: "oauthres_other", uri: "https://other.example.com/mcp" }));

    const result = await clerk.raw("--mode", "agent", "agents", "mcp", "check");

    expect(result.exitCode).toBe(2);
    expect(JSON.parse(result.stderr).error.message).toContain("https://other.example.com/mcp");
  });

  test("check rejects an invalid URL without a request", async () => {
    const result = await clerk.raw(
      "--mode",
      "agent",
      "agents",
      "mcp",
      "check",
      "http://mcp.example.com/mcp",
    );

    expect(result.exitCode).toBe(2);
    expect(http.requests).toHaveLength(0);
  });

  test.each([
    { flag: "prod", instance: "ins_prod" },
    { flag: "ins_dev", instance: "ins_dev" },
  ])("check --app app_1 --instance $flag reads $instance", async ({ flag, instance }) => {
    await setProfile("github.com/test/project", {
      workspaceId: "",
      appId: "app_other",
      instances: { development: "ins_other" },
    });

    const { stdout } = await clerk(
      "--mode",
      "agent",
      "agents",
      "mcp",
      "check",
      SERVER_URL,
      "--app",
      "app_1",
      "--instance",
      flag,
    );

    expect(sent("GET", `/instances/${instance}/oauth_application_settings`)).toHaveLength(1);
    expect(sent("GET", `/instances/${instance}/oauth_resources`)).toHaveLength(1);
    expect(JSON.parse(stdout)).toMatchObject({ application_id: "app_1", instance_id: instance });
  });

  test("check in human mode lists each check on stderr", async () => {
    settings = { ...settings, aud_claim_enabled: false };

    const result = await clerk.raw("--mode", "human", "agents", "mcp", "check", SERVER_URL);

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("resource_registered:");
    expect(result.stderr).toContain("aud_claim_enabled: Access tokens carry no audience claim");
  });

  test("check --json prints JSON in human mode", async () => {
    const { stdout } = await clerk(
      "--mode",
      "human",
      "agents",
      "mcp",
      "check",
      SERVER_URL,
      "--json",
    );

    expect(JSON.parse(stdout).passed).toBe(true);
  });
});
