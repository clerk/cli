import { test, expect, describe, beforeEach, afterEach, mock, spyOn } from "bun:test";
import { capturedOutput } from "../../test/lib/stubs.ts";

const mockCreateApplication = mock();
const mockFetchApplication = mock();
mock.module("../../lib/plapi.ts", () => ({
  createApplication: (...args: unknown[]) => mockCreateApplication(...args),
  fetchApplication: (...args: unknown[]) => mockFetchApplication(...args),
  PlapiError: class PlapiError extends Error {},
}));

const mockIsAgent = mock();
mock.module("../../mode.ts", () => ({
  isAgent: (...args: unknown[]) => mockIsAgent(...args),
  isHuman: (...args: unknown[]) => !mockIsAgent(...args),
  setMode: () => {},
  getMode: () => "human",
}));

const { create } = await import("./create.ts");

const mockApp = {
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
};

describe("apps create", () => {
  let logSpy: ReturnType<typeof spyOn>;
  let errorSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    mockIsAgent.mockReturnValue(false);
    mockCreateApplication.mockResolvedValue({
      application_id: "app_abc123",
      name: "My SaaS App",
    });
    mockFetchApplication.mockResolvedValue(mockApp);
    logSpy = spyOn(console, "log").mockImplementation(() => {});
    errorSpy = spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    mockCreateApplication.mockReset();
    mockFetchApplication.mockReset();
    mockIsAgent.mockReset();
    logSpy.mockRestore();
    errorSpy.mockRestore();
  });

  test("calls createApplication then fetchApplication", async () => {
    await create("My SaaS App");

    expect(mockCreateApplication).toHaveBeenCalledWith("My SaaS App");
    expect(mockFetchApplication).toHaveBeenCalledWith("app_abc123");
  });

  describe("human output", () => {
    test("shows created app name and id", async () => {
      await create("My SaaS App");

      const output = capturedOutput(logSpy);
      expect(output).toContain("Created");
      expect(output).toContain("My SaaS App");
      expect(output).toContain("app_abc123");
    });

    test("falls back to app id when name is absent", async () => {
      mockCreateApplication.mockResolvedValue({ application_id: "app_noname" });
      mockFetchApplication.mockResolvedValue({
        application_id: "app_noname",
        instances: [
          { instance_id: "ins_1", environment_type: "development", publishable_key: "pk_test" },
        ],
      });

      await create("Some Name");

      const output = capturedOutput(logSpy);
      expect(output).toContain("app_noname");
    });

    test("does not show secret keys", async () => {
      await create("My SaaS App");

      const output = capturedOutput(logSpy);
      expect(output).not.toContain("sk_test_xxx");
      expect(output).not.toContain("sk_live_xxx");
    });

    test("shows next steps on stderr", async () => {
      await create("My SaaS App");

      const output = capturedOutput(errorSpy);
      expect(output).toContain("clerk link");
      expect(output).toContain("clerk env pull");
    });
  });

  describe("JSON output", () => {
    test("outputs JSON when --json flag is set", async () => {
      await create("My SaaS App", { json: true });

      const output = capturedOutput(logSpy);
      const parsed = JSON.parse(output);
      expect(parsed.application_id).toBe("app_abc123");
      expect(parsed.name).toBe("My SaaS App");
      expect(parsed.instances).toHaveLength(2);
    });

    test("outputs JSON in agent mode", async () => {
      mockIsAgent.mockReturnValue(true);

      await create("My SaaS App");

      const output = capturedOutput(logSpy);
      const parsed = JSON.parse(output);
      expect(parsed.application_id).toBe("app_abc123");
    });

    test("does not show next steps", async () => {
      mockIsAgent.mockReturnValue(true);

      await create("My SaaS App");

      const output = capturedOutput(errorSpy);
      expect(output).not.toContain("clerk link");
      expect(output).not.toContain("clerk env pull");
    });

    test("strips secret_key from JSON", async () => {
      await create("My SaaS App", { json: true });

      const output = capturedOutput(logSpy);
      const parsed = JSON.parse(output);
      for (const instance of parsed.instances) {
        expect(instance).not.toHaveProperty("secret_key");
        expect(instance).toHaveProperty("publishable_key");
      }
    });
  });

  describe("error handling", () => {
    test("propagates createApplication failure without fetching", async () => {
      mockCreateApplication.mockRejectedValue(new Error("Unprocessable Entity"));

      await expect(create("Bad App")).rejects.toThrow("Unprocessable Entity");
      expect(mockFetchApplication).not.toHaveBeenCalled();
    });

    test("propagates fetchApplication failure after create", async () => {
      mockFetchApplication.mockRejectedValue(new Error("Service Unavailable"));

      await expect(create("My SaaS App")).rejects.toThrow("Service Unavailable");
    });
  });
});
