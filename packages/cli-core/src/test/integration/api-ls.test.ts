/**
 * Discover request body fields with `clerk api ls <path>`
 * An agent reads an endpoint's body shape before sending the request.
 */

import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { join } from "node:path";
import { useIntegrationTestHarness, http, clerk } from "./lib/harness.ts";

const h = useIntegrationTestHarness();

const BAPI_SPEC = `
openapi: "3.0.0"
info:
  title: Backend API
  version: "1.0"
paths:
  /users:
    get:
      tags: [Users]
      summary: List all users
      operationId: GetUserList
    post:
      tags: [Users]
      summary: Create a new user
      operationId: CreateUser
      requestBody:
        required: true
        content:
          application/json:
            schema:
              type: object
              properties:
                email_address:
                  type: array
                  items:
                    type: string
                  description: Email addresses to add to the user.
                first_name:
                  type: string
                  nullable: true
                  description: The first name to assign to the user
                password:
                  type: string
                  description: |-
                    The plaintext password to give the user.
                    Must be at least 8 characters long.
              required: [password]
  /users/{user_id}:
    get:
      tags: [Users]
      summary: Retrieve a user
      operationId: GetUser
      parameters:
        - name: user_id
          in: path
  /users/{user_id}/logout:
    post:
      tags: [Users]
      summary: Log out a user
      operationId: LogoutUser
      requestBody:
        content:
          application/json:
            schema:
              type: object
  /invitations/bulk:
    post:
      tags: [Invitations]
      summary: Create multiple invitations
      operationId: CreateBulkInvitations
      requestBody:
        content:
          application/json:
            schema:
              type: array
              items:
                type: object
                properties:
                  email_address:
                    type: string
                  notify:
                    type: boolean
                required: [email_address]
`;

const PLATFORM_SPEC = `
openapi: "3.0.0"
info:
  title: Platform API
  version: "1.0"
paths:
  /platform/applications/{applicationID}/instances/{envOrInsID}/oauth_resources:
    get:
      tags: [OAuth Resources]
      summary: List OAuth resources
      operationId: PlatformListOAuthResources
    post:
      tags: [OAuth Resources]
      summary: Create an OAuth resource
      operationId: PlatformCreateOAuthResource
      requestBody:
        required: true
        content:
          application/json:
            schema:
              $ref: "#/components/schemas/PlatformCreateOAuthResourceRequest"
components:
  schemas:
    PlatformCreateOAuthResourceRequest:
      allOf:
        - $ref: "#/components/schemas/OAuthResourceBase"
        - type: object
          properties:
            mcp_server:
              type: boolean
              description: Whether the resource is an MCP server.
            kind:
              type: string
              enum: [api, mcp]
    OAuthResourceBase:
      type: object
      properties:
        uri:
          type: string
          description: The resource URI.
        name:
          type: string
      required: [uri]
`;

const SPEC_URLS = {
  bapi: "https://raw.githubusercontent.com/clerk/openapi-specs/main/bapi/2025-11-10.yml",
  platform: "https://raw.githubusercontent.com/clerk/openapi-specs/main/platform/beta.yml",
};

/** Serve the fixture specs at their published URLs; anything else is unexpected. */
function stubSpecs() {
  http.stub(async (url) => {
    if (url === SPEC_URLS.bapi) return new Response(BAPI_SPEC);
    if (url === SPEC_URLS.platform) return new Response(PLATFORM_SPEC);
    throw new Error(`Unexpected fetch: ${url}`);
  });
}

/** Output lines with trailing padding removed and runs of spaces collapsed. */
function lines(stdout: string): string[] {
  return stdout.split("\n").map((line) => line.trim().replace(/ {2,}/g, "  "));
}

describe("api ls <path> shows request body fields", () => {
  beforeEach(async () => {
    const { _setCacheDir } = await import("../../commands/api/catalog.ts");
    _setCacheDir(h.tempDir);
    stubSpecs();
  });

  afterEach(async () => {
    const { _setCacheDir } = await import("../../commands/api/catalog.ts");
    _setCacheDir(undefined);
  });

  test.each([{ mode: "human" }, { mode: "agent" }])(
    "prints Backend body fields with types and required markers ($mode mode)",
    async ({ mode }) => {
      const { stdout } = await clerk("--mode", mode, "api", "ls", "/users");

      expect(http.requests.map((r) => `${r.method} ${r.url}`)).toEqual([`GET ${SPEC_URLS.bapi}`]);
      const out = lines(stdout);
      const post = out.indexOf("POST  /users  Create a new user");
      expect(post).toBeGreaterThan(-1);
      expect(out.slice(post + 1, post + 5)).toEqual([
        "Body (application/json, required):",
        "email_address  string[]  Email addresses to add to the user.",
        "first_name  string | null  The first name to assign to the user",
        "password  string  required  The plaintext password to give the user.",
      ]);
    },
  );

  test("leaves endpoints without a body as a single row", async () => {
    const { stdout } = await clerk("api", "ls", "/users");

    const out = lines(stdout);
    const get = out.indexOf("GET  /users  List all users");
    expect(get).toBeGreaterThan(-1);
    expect(out[get + 1]).toBe("POST  /users  Create a new user");
    expect(out).toContain("GET  /users/{user_id}  Retrieve a user");
  });

  test("keyword filters list rows only, without body fields", async () => {
    const { stdout } = await clerk("api", "ls", "users");

    expect(stdout).toContain("Create a new user");
    expect(stdout).not.toContain("Body (");
  });

  test("accepts a /v1-prefixed path", async () => {
    const { stdout } = await clerk("api", "ls", "/v1/users");

    expect(lines(stdout)).toContain("Body (application/json, required):");
  });

  test("refetches a fresh catalog cached before body fields were kept", async () => {
    const legacy = {
      endpoints: [
        {
          method: "POST",
          path: "/users",
          summary: "Create a new user",
          tag: "Users",
          operationId: "CreateUser",
          pathParams: [],
          hasRequestBody: true,
        },
      ],
      tags: ["Users"],
      fetchedAt: Date.now(),
    };
    await Bun.write(join(h.tempDir, "bapi-catalog.json"), JSON.stringify(legacy));

    const { stdout } = await clerk("api", "ls", "/users");

    expect(http.requests.map((r) => r.url)).toEqual([SPEC_URLS.bapi]);
    expect(lines(stdout)).toContain("Body (application/json, required):");
  });

  test("marks a body that declares no fields", async () => {
    const { stdout } = await clerk("api", "ls", "/users/{user_id}/logout");

    const out = lines(stdout);
    const post = out.indexOf("POST  /users/{user_id}/logout  Log out a user");
    expect(post).toBeGreaterThan(-1);
    expect(out.slice(post + 1, post + 3)).toEqual(["Body (application/json):", "(no fields)"]);
  });

  test("describes the items of an array body", async () => {
    const { stdout } = await clerk("api", "ls", "/invitations/bulk");

    const out = lines(stdout);
    const post = out.indexOf("POST  /invitations/bulk  Create multiple invitations");
    expect(out.slice(post + 1, post + 4)).toEqual([
      "Body (application/json, array of object):",
      "email_address  string  required",
      "notify  boolean",
    ]);
  });

  test("prints Platform body fields resolved through $ref and allOf", async () => {
    const path = "/platform/applications/{applicationID}/instances/{envOrInsID}/oauth_resources";
    const { stdout } = await clerk("api", "ls", path, "--platform");

    expect(http.requests.map((r) => `${r.method} ${r.url}`)).toEqual([`GET ${SPEC_URLS.platform}`]);
    const out = lines(stdout);
    const post = out.indexOf(`POST  ${path}  Create an OAuth resource`);
    expect(post).toBeGreaterThan(-1);
    expect(out.slice(post + 1, post + 6)).toEqual([
      "Body (application/json, required):",
      "uri  string  required  The resource URI.",
      "name  string",
      "mcp_server  boolean  Whether the resource is an MCP server.",
      'kind  "api" | "mcp"',
    ]);
  });
});
