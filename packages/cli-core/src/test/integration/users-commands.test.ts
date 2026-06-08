/**
 * Exercise primary users flows through the real CLI program.
 * Covers create against linked-project, --app, --secret-key, raw -d/--data,
 * --dry-run, and the wizard picker fallback when no project is linked, plus
 * list wired up against linked-project resolution.
 */

import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import {
  MOCK_APP,
  MOCK_USERS,
  clerk,
  getInstance,
  http,
  mockState,
  mockPrompts,
  setProfile,
  useIntegrationTestHarness,
} from "./lib/harness.ts";

const harness = useIntegrationTestHarness();

const CREATED_USER = {
  id: "user_2",
  email_addresses: [{ email_address: "alice@example.com" }],
  first_name: "Alice",
};

const PLAPI_APP_ROUTE = "/v1/platform/applications/app_1?include_secret_keys=true";
const BAPI_USERS_ROUTE = "https://test-bapi.clerk.dev/v1/users";

function findBapiCreateRequest() {
  return http.requests.find(
    (request) => request.method === "POST" && request.url.includes(BAPI_USERS_ROUTE),
  );
}

describe("users commands", () => {
  const devInstance = getInstance(MOCK_APP, "development");

  async function linkDevProject() {
    await setProfile("github.com/test/project", {
      workspaceId: "",
      appId: MOCK_APP.application_id,
      appName: MOCK_APP.name,
      instances: { development: devInstance.instance_id },
    });
  }

  test.each([{ mode: "human" }, { mode: "agent" }])(
    "creates a user from linked project context ($mode mode)",
    async ({ mode }) => {
      await linkDevProject();
      http.mock({
        [PLAPI_APP_ROUTE]: MOCK_APP,
        "/v1/users": CREATED_USER,
      });

      const { stdout: createOutput, stderr: createStderr } = await clerk(
        "--mode",
        mode,
        "users",
        "create",
        "--email",
        "alice@example.com",
        "--first-name",
        "Alice",
        "--yes",
      );

      if (mode === "human") {
        expect(createOutput).toBe("");
        expect(createStderr).toContain("Created user");
        expect(createStderr).toContain("user_2");
      } else {
        expect(JSON.parse(createOutput)).toEqual(CREATED_USER);
      }

      const createRequest = findBapiCreateRequest();
      expect(createRequest).toBeDefined();
      expect(JSON.parse(createRequest!.body!)).toEqual({
        email_address: ["alice@example.com"],
        first_name: "Alice",
      });
    },
  );

  test("creates a user from a raw -d/--data payload", async () => {
    await linkDevProject();
    http.mock({
      [PLAPI_APP_ROUTE]: MOCK_APP,
      "/v1/users": CREATED_USER,
    });

    await clerk(
      "--mode",
      "human",
      "users",
      "create",
      "-d",
      '{"email_address":["alice@example.com"],"first_name":"Alice","skip_password_requirement":true}',
      "--yes",
    );

    const createRequest = findBapiCreateRequest();
    expect(createRequest).toBeDefined();
    expect(JSON.parse(createRequest!.body!)).toEqual({
      email_address: ["alice@example.com"],
      first_name: "Alice",
      skip_password_requirement: true,
    });
  });

  test("creates a user from a --file payload", async () => {
    await linkDevProject();
    http.mock({
      [PLAPI_APP_ROUTE]: MOCK_APP,
      "/v1/users": CREATED_USER,
    });

    const payloadPath = join(harness.tempDir, "user.json");
    await writeFile(
      payloadPath,
      JSON.stringify({ email_address: ["alice@example.com"], first_name: "Alice" }),
    );

    await clerk("--mode", "human", "users", "create", "--file", payloadPath, "--yes");

    const createRequest = findBapiCreateRequest();
    expect(createRequest).toBeDefined();
    expect(JSON.parse(createRequest!.body!)).toEqual({
      email_address: ["alice@example.com"],
      first_name: "Alice",
    });
  });

  test("--dry-run redacts the preview and skips the BAPI call", async () => {
    await linkDevProject();
    // No /v1/users route: any POST would fail the test's "unmocked fetch" guard.
    http.mock({});

    const { stdout, stderr } = await clerk(
      "--mode",
      "human",
      "users",
      "create",
      "--email",
      "alice@example.com",
      "--password",
      "Sup3rSecret!",
      "--dry-run",
    );

    expect(stderr).toContain("[dry-run] POST /v1/users");
    // Dry-run preview now renders to stderr (with the intro/outro gutter); stdout stays clean.
    expect(stderr).toContain('"alice@example.com"');
    expect(stderr).toContain('"[REDACTED]"');
    expect(stdout).toBe("");
    expect(findBapiCreateRequest()).toBeUndefined();
  });

  test("--secret-key targets BAPI directly without resolving an app", async () => {
    // No setProfile and no plapi mock: hitting platform API would fail.
    http.mock({
      "/v1/users": CREATED_USER,
    });

    await clerk(
      "--mode",
      "human",
      "users",
      "create",
      "--secret-key",
      "sk_test_directkey",
      "--email",
      "alice@example.com",
      "--yes",
    );

    const createRequest = findBapiCreateRequest();
    expect(createRequest).toBeDefined();
    const authHeader = createRequest!.url; // URL recorded in our mock; auth header lives on init
    expect(authHeader).toContain("/v1/users");

    const platformCall = http.requests.find((r) => r.url.includes("/v1/platform/applications"));
    expect(platformCall).toBeUndefined();
  });

  test("--app resolves the secret key via platform API without a linked project", async () => {
    // No setProfile call: app must come from --app, not config.
    http.mock({
      [PLAPI_APP_ROUTE]: MOCK_APP,
      "/v1/users": CREATED_USER,
    });

    await clerk(
      "--mode",
      "human",
      "users",
      "create",
      "--app",
      "app_1",
      "--email",
      "alice@example.com",
      "--yes",
    );

    const createRequest = findBapiCreateRequest();
    expect(createRequest).toBeDefined();
    expect(JSON.parse(createRequest!.body!)).toEqual({
      email_address: ["alice@example.com"],
    });

    const fetchAppCall = http.requests.find(
      (r) => r.method === "GET" && r.url.includes("/v1/platform/applications/app_1"),
    );
    expect(fetchAppCall).toBeDefined();
  });

  test("wizard picker fallback resolves the secret key when no project is linked (regression for 5eed0763)", async () => {
    // No setProfile: resolveAppContext throws NOT_LINKED, wizard falls back to picker.
    http.mock({
      "/v1/platform/applications": [MOCK_APP],
      [PLAPI_APP_ROUTE]: MOCK_APP,
      "/v1/users": CREATED_USER,
    });

    // Picker returns app_1; wizard then prompts for the optional curated set
    // because MOCK_APP's publishable key does not decode to a valid fapiHost
    // (the wizard skips the FAPI fetch and falls back to optional curated fields).
    mockPrompts.search("app_1");
    mockPrompts.input("alice@example.com"); // email
    mockPrompts.input(""); // phone
    mockPrompts.input(""); // username
    mockPrompts.password(""); // password
    mockPrompts.input(""); // first name
    mockPrompts.input(""); // last name

    await clerk("--mode", "human", "users", "create", "--yes");

    const createRequest = findBapiCreateRequest();
    expect(createRequest).toBeDefined();
    expect(JSON.parse(createRequest!.body!)).toEqual({
      email_address: ["alice@example.com"],
    });

    // The picker fetched the application list, then the wizard fetched the
    // picked app to resolve the secret key. Both calls must have happened.
    const listCall = http.requests.find(
      (r) => r.method === "GET" && r.url.endsWith("/v1/platform/applications"),
    );
    expect(listCall).toBeDefined();
    const fetchAppCall = http.requests.find(
      (r) => r.method === "GET" && r.url.includes("/v1/platform/applications/app_1"),
    );
    expect(fetchAppCall).toBeDefined();
  });

  test("agent mode without flags or input throws a usage error and never prompts", async () => {
    await linkDevProject();
    http.mock({});

    const { stderr, stdout, exitCode } = await clerk.raw("--mode", "agent", "users", "create");

    expect(exitCode).not.toBe(0);
    expect(stderr + stdout).toContain("No input provided");
    expect(findBapiCreateRequest()).toBeUndefined();
  });

  test.each([{ mode: "human" }, { mode: "agent" }])(
    "lists users from linked project context ($mode mode)",
    async ({ mode }) => {
      await setProfile("github.com/test/project", {
        workspaceId: "",
        appId: MOCK_APP.application_id,
        appName: MOCK_APP.name,
        instances: { development: devInstance.instance_id },
      });

      http.mock({
        "/v1/platform/applications/app_1?include_secret_keys=true": MOCK_APP,
        "/v1/users": MOCK_USERS,
      });

      const { stdout, stderr } = await clerk("--mode", mode, "users", "list");

      if (mode === "human") {
        expect(stderr).toContain("John Doe");
        expect(stderr).toContain("john@example.com");
        expect(stderr).toContain("1 user returned");
      } else {
        expect(JSON.parse(stdout)).toEqual({ data: MOCK_USERS, hasMore: false });
      }

      expect(
        http.requests.some(
          (request) =>
            request.method === "GET" &&
            request.url.includes("/v1/platform/applications/app_1") &&
            request.url.includes("include_secret_keys=true"),
        ),
      ).toBe(true);
      expect(
        http.requests.some(
          (request) =>
            request.method === "GET" &&
            request.url.includes("https://test-bapi.clerk.dev/v1/users"),
        ),
      ).toBe(true);
    },
  );

  test("list resolves the secret key via --app without a linked project", async () => {
    // No setProfile call: --app must thread through the parent command's
    // option, not silently fall through to the no-secret-key error.
    http.mock({
      [PLAPI_APP_ROUTE]: MOCK_APP,
      "/v1/users": MOCK_USERS,
    });

    const { stdout, exitCode } = await clerk.raw(
      "--mode",
      "agent",
      "users",
      "list",
      "--app",
      "app_1",
      "--instance",
      "development",
    );

    expect(exitCode).toBe(0);
    expect(JSON.parse(stdout)).toEqual({ data: MOCK_USERS, hasMore: false });

    const fetchAppCall = http.requests.find(
      (request) =>
        request.method === "GET" && request.url.includes("/v1/platform/applications/app_1"),
    );
    expect(fetchAppCall).toBeDefined();
  });

  test("users open prints a linked-project URL without PLAPI auth when the user id is already known", async () => {
    await linkDevProject();
    delete process.env.CLERK_PLATFORM_API_KEY;
    mockState.storedToken = null;
    http.mock({});

    const { stdout, exitCode } = await clerk.raw(
      "--mode",
      "agent",
      "users",
      "open",
      "user_123",
      "--print",
    );

    expect(exitCode).toBe(0);
    expect(stdout).toBe(
      `https://dashboard.clerk.com/apps/${MOCK_APP.application_id}/instances/${devInstance.instance_id}/users/user_123`,
    );
    expect(http.requests).toHaveLength(0);
  });

  test("users open accepts --secret-key with --app and prints the dashboard URL without PLAPI auth", async () => {
    delete process.env.CLERK_PLATFORM_API_KEY;
    mockState.storedToken = null;
    http.mock({
      "/v1/instance": {
        id: devInstance.instance_id,
        publishable_key: devInstance.publishable_key,
      },
    });

    const { stdout, exitCode } = await clerk.raw(
      "--mode",
      "agent",
      "users",
      "open",
      "user_123",
      "--secret-key",
      "sk_test_directkey",
      "--app",
      "app_1",
      "--print",
    );

    expect(exitCode).toBe(0);
    expect(stdout).toBe(
      `https://dashboard.clerk.com/apps/${MOCK_APP.application_id}/instances/${devInstance.instance_id}/users/user_123`,
    );

    const fetchAppCall = http.requests.find(
      (request) =>
        request.method === "GET" && request.url.includes("/v1/platform/applications/app_1"),
    );
    expect(fetchAppCall).toBeUndefined();
  });
});
