import { test, expect, describe, beforeEach, mock } from "bun:test";

const mockResolveAppContext = mock();
const mockFetchApplication = mock();

mock.module("../../../lib/config.ts", () => ({
  resolveAppContext: (...args: unknown[]) => mockResolveAppContext(...args),
  resolveFetchedApplicationInstance: (
    _appId: string,
    app: {
      instances: {
        environment_type: string;
        instance_id: string;
        secret_key?: string;
        publishable_key: string;
      }[];
    },
    _instance?: string,
  ) => {
    const development = app.instances.find((i) => i.environment_type === "development");
    if (!development) return { found: false, instanceId: "unknown", instanceLabel: "unknown" };
    return {
      found: true,
      instance: development,
      instanceId: development.instance_id,
      instanceLabel: "development",
    };
  },
}));
mock.module("../../../lib/plapi.ts", () => ({
  fetchApplication: (...args: unknown[]) => mockFetchApplication(...args),
  validateKeyPrefix: () => {},
}));

const { resolveUsersInstanceContext } = await import("./instance-context.ts");

describe("resolveUsersInstanceContext", () => {
  beforeEach(() => {
    mockResolveAppContext.mockReset();
    mockFetchApplication.mockReset();
  });

  test("returns publishable key when --app is provided", async () => {
    mockFetchApplication.mockResolvedValue({
      application_id: "app_123",
      instances: [
        {
          instance_id: "ins_dev",
          environment_type: "development",
          publishable_key: "pk_test_aWRlYWwtbG91c2UtNjEuY2xlcmsuYWNjb3VudHMuZGV2JA",
          secret_key: "sk_test_xyz",
        },
      ],
    });

    const ctx = await resolveUsersInstanceContext({ app: "app_123" });
    expect(ctx.secretKey).toBe("sk_test_xyz");
    expect(ctx.publishableKey).toBe("pk_test_aWRlYWwtbG91c2UtNjEuY2xlcmsuYWNjb3VudHMuZGV2JA");
    expect(ctx.fapiHost).toBe("ideal-louse-61.clerk.accounts.dev");
  });

  test("returns undefined publishable key when only --secret-key is provided", async () => {
    const ctx = await resolveUsersInstanceContext({ secretKey: "sk_test_raw" });
    expect(ctx.secretKey).toBe("sk_test_raw");
    expect(ctx.publishableKey).toBeUndefined();
    expect(ctx.fapiHost).toBeUndefined();
  });
});
