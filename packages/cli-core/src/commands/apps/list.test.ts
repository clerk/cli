import { test, expect, describe, beforeEach, afterEach, mock, spyOn } from "bun:test";
import { captureLog, captureUi } from "../../test/lib/stubs.ts";

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
  let captured: ReturnType<typeof captureLog>;
  let uiCapture: ReturnType<typeof captureUi>;

  beforeEach(() => {
    mockIsAgent.mockReturnValue(false);
    logSpy = spyOn(console, "log").mockImplementation(() => {});
    errorSpy = spyOn(console, "error").mockImplementation(() => {});
    uiCapture = captureUi();
    uiCapture.install();
    captured = captureLog();
  });

  afterEach(() => {
    uiCapture.teardown();
    captured.teardown();
    mockListApplications.mockReset();
    mockIsAgent.mockReset();
    logSpy.mockRestore();
    errorSpy.mockRestore();
  });

  function runList(options: Parameters<typeof list>[0] = {}) {
    return captured.run(() => list(options));
  }

  const stdoutOut = () => uiCapture.out;

  describe("compact table (default)", () => {
    test("lists apps with name, id, and environments", async () => {
      mockListApplications.mockResolvedValue(mockApps);

      await runList();

      const out = stdoutOut();
      expect(out).toContain("My SaaS App");
      expect(out).toContain("app_abc123");
      expect(out).toContain("development, production");
      expect(out).toContain("Side Project");
      expect(out).toContain("app_xyz789");
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

      await runList();

      expect(stdoutOut()).toContain("app_noname");
    });

    test("does not show secret keys", async () => {
      mockListApplications.mockResolvedValue(mockApps);

      await runList();

      const out = stdoutOut();
      expect(out).not.toContain("sk_test_xxx");
      expect(out).not.toContain("sk_live_xxx");
    });

    test("shows count summary", async () => {
      mockListApplications.mockResolvedValue(mockApps);

      await runList();

      expect(stdoutOut()).toContain("2 applications");
    });

    test("shows singular count for one app", async () => {
      mockListApplications.mockResolvedValue([mockApps[0]]);

      await runList();

      const out = stdoutOut();
      expect(out).toContain("1 application");
      expect(out).not.toContain("1 applications");
    });
  });

  describe("JSON output", () => {
    test("outputs JSON when --json flag is set", async () => {
      mockListApplications.mockResolvedValue(mockApps);

      await runList({ json: true });

      const parsed = JSON.parse(captured.out);
      expect(parsed).toHaveLength(2);
      expect(parsed[0].application_id).toBe("app_abc123");
      expect(parsed[0].name).toBe("My SaaS App");
    });

    test("outputs JSON in agent mode", async () => {
      mockIsAgent.mockReturnValue(true);
      mockListApplications.mockResolvedValue(mockApps);

      await runList();

      const parsed = JSON.parse(captured.out);
      expect(parsed).toHaveLength(2);
    });

    test("strips secret_key from JSON", async () => {
      mockListApplications.mockResolvedValue(mockApps);

      await runList({ json: true });

      expect(captured.out).not.toContain("sk_test_xxx");
      expect(captured.out).not.toContain("sk_live_xxx");
      expect(captured.out).not.toContain("secret_key");
    });
  });

  describe("empty state", () => {
    test("shows helpful message when no apps found", async () => {
      mockListApplications.mockResolvedValue([]);

      await runList();

      const out = stdoutOut();
      expect(out).toContain("No applications found");
      expect(out).toContain("dashboard.clerk.com");
    });

    test("outputs empty JSON array when --json flag is set", async () => {
      mockListApplications.mockResolvedValue([]);

      await runList({ json: true });

      const parsed = JSON.parse(captured.out);
      expect(parsed).toEqual([]);
    });

    test("outputs empty JSON array in agent mode", async () => {
      mockIsAgent.mockReturnValue(true);
      mockListApplications.mockResolvedValue([]);

      await runList();

      const parsed = JSON.parse(captured.out);
      expect(parsed).toEqual([]);
    });
  });
});
