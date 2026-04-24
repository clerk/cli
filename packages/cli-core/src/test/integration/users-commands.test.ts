/**
 * Exercise primary users flows through the real CLI program.
 * Covers create wired up against linked-project resolution.
 */

import { describe, expect, test } from "bun:test";
import {
  MOCK_APP,
  clerk,
  getInstance,
  http,
  setProfile,
  useIntegrationTestHarness,
} from "./lib/harness.ts";

useIntegrationTestHarness();

describe("users commands", () => {
  const devInstance = getInstance(MOCK_APP, "development");

  test.each([{ mode: "human" }, { mode: "agent" }])(
    "creates a user from linked project context ($mode mode)",
    async ({ mode }) => {
      await setProfile("github.com/test/project", {
        workspaceId: "",
        appId: MOCK_APP.application_id,
        appName: MOCK_APP.name,
        instances: { development: devInstance.instance_id },
      });

      const createdUser = {
        id: "user_2",
        email_addresses: [{ email_address: "alice@example.com" }],
        first_name: "Alice",
      };
      http.mock({
        "/v1/platform/applications/app_1?include_secret_keys=true": MOCK_APP,
        "/v1/users": createdUser,
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
        expect(JSON.parse(createOutput)).toEqual(createdUser);
      }

      const createRequest = http.requests.find(
        (request) =>
          request.method === "POST" && request.url.includes("https://test-bapi.clerk.dev/v1/users"),
      );
      expect(createRequest).toBeDefined();
      expect(JSON.parse(createRequest!.body!)).toEqual({
        email_address: ["alice@example.com"],
        first_name: "Alice",
      });
    },
  );
});
