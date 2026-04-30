import { test, expect, describe, beforeEach, mock } from "bun:test";
import { CliError, ERROR_CODE } from "../../../lib/errors.ts";

const mockResolveAppContext = mock();
const mockFetchApplication = mock();
const mockFetchAppsTolerantly = mock();
const mockPickOrCreateApp = mock();
const mockIsHuman = mock(() => true);

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
mock.module("../../../lib/app-picker.ts", () => ({
  fetchAppsTolerantly: (...args: unknown[]) => mockFetchAppsTolerantly(...args),
  pickOrCreateApp: (...args: unknown[]) => mockPickOrCreateApp(...args),
  appLabel: (a: { application_id: string }) => a.application_id,
}));
mock.module("../../../mode.ts", () => ({
  isHuman: () => mockIsHuman(),
  isAgent: () => !mockIsHuman(),
  setMode: () => {},
  getMode: () => "human",
}));

const { resolveUsersInstanceContext } = await import("./instance-context.ts");

describe("resolveUsersInstanceContext", () => {
  beforeEach(() => {
    mockResolveAppContext.mockReset();
    mockFetchApplication.mockReset();
    mockFetchAppsTolerantly.mockReset();
    mockPickOrCreateApp.mockReset();
    mockIsHuman.mockReturnValue(true);
  });

  test("returns app and instance labels when --app is provided", async () => {
    mockFetchApplication.mockResolvedValue({
      application_id: "app_123",
      name: "My App",
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
    expect(ctx.appId).toBe("app_123");
    expect(ctx.appLabel).toBe("My App");
    expect(ctx.instanceId).toBe("ins_dev");
    expect(ctx.instanceLabel).toBe("development");
    expect(ctx.publishableKey).toBe("pk_test_aWRlYWwtbG91c2UtNjEuY2xlcmsuYWNjb3VudHMuZGV2JA");
    expect(ctx.fapiHost).toBe("ideal-louse-61.clerk.accounts.dev");
  });

  test("returns undefined publishable key when only --secret-key is provided", async () => {
    const ctx = await resolveUsersInstanceContext({ secretKey: "sk_test_raw" });
    expect(ctx.secretKey).toBe("sk_test_raw");
    expect(ctx.publishableKey).toBeUndefined();
    expect(ctx.fapiHost).toBeUndefined();
  });

  test("falls back to picker when no project linked and human mode", async () => {
    mockResolveAppContext.mockRejectedValue(
      new CliError("No Clerk project linked", { code: ERROR_CODE.NOT_LINKED }),
    );
    mockFetchAppsTolerantly.mockResolvedValue([{ application_id: "app_picked", name: "Picked" }]);
    mockPickOrCreateApp.mockResolvedValue({ application_id: "app_picked", name: "Picked" });
    mockFetchApplication.mockResolvedValue({
      application_id: "app_picked",
      name: "Picked",
      instances: [
        {
          instance_id: "ins_dev",
          environment_type: "development",
          publishable_key: "pk_test_aWRlYWwtbG91c2UtNjEuY2xlcmsuYWNjb3VudHMuZGV2JA",
          secret_key: "sk_test_picked",
        },
      ],
    });

    const ctx = await resolveUsersInstanceContext({});
    expect(mockPickOrCreateApp).toHaveBeenCalled();
    expect(ctx.secretKey).toBe("sk_test_picked");
    expect(ctx.appId).toBe("app_picked");
    expect(ctx.appLabel).toBe("Picked");
    expect(ctx.instanceId).toBe("ins_dev");
    expect(ctx.instanceLabel).toBe("development");
    expect(ctx.fapiHost).toBe("ideal-louse-61.clerk.accounts.dev");
  });

  test("re-throws NOT_LINKED in agent mode without invoking picker", async () => {
    mockIsHuman.mockReturnValue(false);
    mockResolveAppContext.mockRejectedValue(
      new CliError("No Clerk project linked", { code: ERROR_CODE.NOT_LINKED }),
    );

    await expect(resolveUsersInstanceContext({})).rejects.toThrow(CliError);
    expect(mockPickOrCreateApp).not.toHaveBeenCalled();
  });

  test("rejects --secret-key combined with --app", async () => {
    await expect(
      resolveUsersInstanceContext({ secretKey: "sk_test_raw", app: "app_123" }),
    ).rejects.toThrow(/--secret-key cannot be combined with --app or --instance/);
    expect(mockFetchApplication).not.toHaveBeenCalled();
  });

  test("rejects --secret-key combined with --instance", async () => {
    await expect(
      resolveUsersInstanceContext({ secretKey: "sk_test_raw", instance: "ins_dev" }),
    ).rejects.toThrow(/--secret-key cannot be combined with --app or --instance/);
    expect(mockResolveAppContext).not.toHaveBeenCalled();
  });
});
