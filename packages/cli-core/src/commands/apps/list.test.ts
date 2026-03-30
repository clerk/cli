import { test, expect, describe, beforeEach, afterEach, mock, spyOn } from "bun:test";
import { capturedOutput } from "../../test/stubs.ts";

const mockListApplications = mock();
mock.module("../../lib/plapi.ts", () => ({
  listApplications: (...args: unknown[]) => mockListApplications(...args),
  PlapiError: class PlapiError extends Error {},
}));

const mockIsAgent = mock();
mock.module("../../mode.ts", () => ({
  isAgent: (...args: unknown[]) => mockIsAgent(...args),
  isHuman: (...args: unknown[]) => !mockIsAgent(...args),
  setMode: () => {},
  getMode: () => "human",
}));

const { list } = await import("./list.ts");

const mockApps = [
  {
    application_id: "app_abc123",
    name: "My SaaS App",
    instances: [
      {
        instance_id: "ins_dev1",
        environment_type: "development",
        publishable_key: "pk_test_xxx",
        secret_key: "sk_test_xxx",
      },
      {
        instance_id: "ins_prod1",
        environment_type: "production",
        publishable_key: "pk_live_xxx",
        secret_key: "sk_live_xxx",
      },
    ],
  },
  {
    application_id: "app_xyz789",
    name: "Side Project",
    instances: [
      {
        instance_id: "ins_dev2",
        environment_type: "development",
        publishable_key: "pk_test_yyy",
      },
    ],
  },
];

describe("apps list", () => {
  let logSpy: ReturnType<typeof spyOn>;
  let errorSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    mockIsAgent.mockReturnValue(false);
    logSpy = spyOn(console, "log").mockImplementation(() => {});
    errorSpy = spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    mockListApplications.mockReset();
    mockIsAgent.mockReset();
    logSpy.mockRestore();
    errorSpy.mockRestore();
  });

  describe("compact table (default)", () => {
    test("lists apps with name, id, and environments", async () => {
      mockListApplications.mockResolvedValue(mockApps);

      await list();

      const output = capturedOutput(logSpy);
      expect(output).toContain("My SaaS App");
      expect(output).toContain("app_abc123");
      expect(output).toContain("development, production");
      expect(output).toContain("Side Project");
      expect(output).toContain("app_xyz789");
    });

    test("shows app id as name when name is absent", async () => {
      mockListApplications.mockResolvedValue([
        {
          application_id: "app_noname",
          instances: [
            { instance_id: "ins_1", environment_type: "development", publishable_key: "pk_test" },
          ],
        },
      ]);

      await list();

      const output = capturedOutput(logSpy);
      expect(output).toContain("app_noname");
    });

    test("does not show secret keys", async () => {
      mockListApplications.mockResolvedValue(mockApps);

      await list();

      const output = capturedOutput(logSpy);
      expect(output).not.toContain("sk_test_xxx");
      expect(output).not.toContain("sk_live_xxx");
    });

    test("shows count summary on stderr", async () => {
      mockListApplications.mockResolvedValue(mockApps);

      await list();

      const summary = capturedOutput(errorSpy);
      expect(summary).toContain("2 applications");
    });

    test("shows singular count for one app", async () => {
      mockListApplications.mockResolvedValue([mockApps[0]]);

      await list();

      const summary = capturedOutput(errorSpy);
      expect(summary).toContain("1 application");
      expect(summary).not.toContain("1 applications");
    });
  });

  describe("JSON output", () => {
    test("outputs JSON when --json flag is set", async () => {
      mockListApplications.mockResolvedValue(mockApps);

      await list({ json: true });

      const output = capturedOutput(logSpy);
      const parsed = JSON.parse(output);
      expect(parsed).toHaveLength(2);
      expect(parsed[0].application_id).toBe("app_abc123");
      expect(parsed[0].name).toBe("My SaaS App");
    });

    test("outputs JSON in agent mode", async () => {
      mockIsAgent.mockReturnValue(true);
      mockListApplications.mockResolvedValue(mockApps);

      await list();

      const output = capturedOutput(logSpy);
      const parsed = JSON.parse(output);
      expect(parsed).toHaveLength(2);
    });

    test("strips secret_key from JSON", async () => {
      mockListApplications.mockResolvedValue(mockApps);

      await list({ json: true });

      const output = capturedOutput(logSpy);
      expect(output).not.toContain("sk_test_xxx");
      expect(output).not.toContain("sk_live_xxx");
      expect(output).not.toContain("secret_key");
    });
  });

  describe("empty state", () => {
    test("shows helpful message when no apps found", async () => {
      mockListApplications.mockResolvedValue([]);

      await list();

      const output = capturedOutput(logSpy);
      expect(output).toContain("No applications found");
      expect(output).toContain("dashboard.clerk.com");
    });

    test("outputs empty JSON array when --json flag is set", async () => {
      mockListApplications.mockResolvedValue([]);

      await list({ json: true });

      const output = capturedOutput(logSpy);
      const parsed = JSON.parse(output);
      expect(parsed).toEqual([]);
    });

    test("outputs empty JSON array in agent mode", async () => {
      mockIsAgent.mockReturnValue(true);
      mockListApplications.mockResolvedValue([]);

      await list();

      const output = capturedOutput(logSpy);
      const parsed = JSON.parse(output);
      expect(parsed).toEqual([]);
    });
  });
});
