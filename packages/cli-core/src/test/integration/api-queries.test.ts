/**
 * Query users and create resources via the API
 * Use the Backend API to manage users.
 */

import { test, expect, describe } from "bun:test";
import {
  useIntegrationTestScenarios,
  http,
  clerk,
  getInstance,
  MOCK_APP,
  MOCK_USERS,
} from "./lib/scenarios.ts";

useIntegrationTestScenarios();

describe("Query users and create resources via the API", () => {
  const devInstance = getInstance(MOCK_APP, "development");
  const mockUser = MOCK_USERS[0]!;
  const mockEmail = mockUser.email_addresses[0]!.email_address;

  test.each([{ mode: "human" }, { mode: "agent" }])(
    "list users and create a user ($mode mode)",
    async ({ mode }) => {
      http.mock({
        "/v1/users": MOCK_USERS,
      });

      // GET /users
      const { stdout: getOutput } = await clerk(
        "--mode",
        mode,
        "api",
        "/users",
        "--secret-key",
        devInstance.secret_key!,
      );
      expect(getOutput).toContain(mockEmail);

      // Verify request was made
      const getReq = http.requests.find((r) => r.method === "GET" && r.url.includes("/users"));
      expect(getReq).toBeDefined();

      // POST /users
      const newUser = {
        id: "user_2",
        email_addresses: [{ email_address: "jane@example.com" }],
      };
      http.mock({ "/v1/users": newUser });

      await clerk(
        "--mode",
        mode,
        "api",
        "/users",
        "--secret-key",
        devInstance.secret_key!,
        "-d",
        '{"email_address":["jane@example.com"]}',
        "--yes",
      );
      const postReq = http.requests.find((r) => r.method === "POST");
      expect(postReq).toBeDefined();
      expect(postReq!.body).toContain("jane@example.com");
    },
  );
});
