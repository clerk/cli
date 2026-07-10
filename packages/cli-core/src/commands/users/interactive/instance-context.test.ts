import { test, expect, describe, beforeEach, afterEach, mock } from "bun:test";
import { CliError, ERROR_CODE } from "../../../lib/errors.ts";
import { stubFetch } from "../../../test/lib/stubs.ts";
import { buildInstancePickerChoices } from "./instance-choices.ts";

const mockResolveAppContext = mock();
const mockResolveProfile = mock();
const mockFetchApplication = mock();
const mockFetchAppsTolerantly = mock();
const mockPickOrCreateApp = mock();
const mockSelect = mock();
const mockIsHuman = mock(() => true);

mock.module("../../../lib/listage.ts", () => ({
  select: (...args: unknown[]) => mockSelect(...args),
}));

mock.module("../../../lib/config.ts", () => ({
  resolveAppContext: (...args: unknown[]) => mockResolveAppContext(...args),
  resolveProfile: (...args: unknown[]) => mockResolveProfile(...args),
  getActiveInstanceForApp: async () => undefined,
  resolveFetchedApplicationInstance: (
    _appId: string,
    app: {
      instances: {
        environment_type: string;
        instance_id: string;
        secret_key?: string;
        publishable_key: string;
        branch_name?: string;
      }[];
    },
    instance?: string,
    branch?: string,
  ) => {
    // Mirrors the real resolver: a branch hint wins outright, otherwise an
    // env-type or instance-id hint wins, otherwise fall back to the
    // development instance. Labels use the matched instance's environment
    // type (or the branch name itself for a branch match).
    if (branch) {
      const matched = app.instances.find((i) => i.branch_name === branch);
      if (!matched) return { found: false, instanceId: branch, instanceLabel: branch };
      return {
        found: true,
        instance: matched,
        instanceId: matched.instance_id,
        instanceLabel: branch,
      };
    }

    const hint = instance ?? "development";
    const matched = app.instances.find(
      (i) => i.environment_type === hint || i.instance_id === hint,
    );
    if (!matched) return { found: false, instanceId: hint, instanceLabel: hint };
    return {
      found: true,
      instance: matched,
      instanceId: matched.instance_id,
      instanceLabel: matched.environment_type,
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
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    mockResolveAppContext.mockReset();
    mockResolveProfile.mockReset();
    mockFetchApplication.mockReset();
    mockFetchAppsTolerantly.mockReset();
    mockPickOrCreateApp.mockReset();
    mockSelect.mockReset();
    mockIsHuman.mockReturnValue(true);
    mockResolveProfile.mockResolvedValue(undefined);
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
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
    expect(mockSelect).not.toHaveBeenCalled();
    expect(ctx.secretKey).toBe("sk_test_picked");
    expect(ctx.appId).toBe("app_picked");
    expect(ctx.appLabel).toBe("Picked");
    expect(ctx.instanceId).toBe("ins_dev");
    expect(ctx.instanceLabel).toBe("development");
    expect(ctx.fapiHost).toBe("ideal-louse-61.clerk.accounts.dev");
  });

  test("prompts for an instance when the picked app has multiple instances", async () => {
    mockResolveAppContext.mockRejectedValue(
      new CliError("No Clerk project linked", { code: ERROR_CODE.NOT_LINKED }),
    );
    mockFetchAppsTolerantly.mockResolvedValue([{ application_id: "app_picked", name: "Picked" }]);
    mockPickOrCreateApp.mockResolvedValue({ application_id: "app_picked", name: "Picked" });
    const instances = [
      {
        instance_id: "ins_dev",
        environment_type: "development",
        publishable_key: "pk_test_aWRlYWwtbG91c2UtNjEuY2xlcmsuYWNjb3VudHMuZGV2JA",
        secret_key: "sk_test_picked",
      },
      {
        instance_id: "ins_prod",
        environment_type: "production",
        publishable_key: "pk_live_aWRlYWwtbG91c2UtNjEuY2xlcmsuYWNjb3VudHMuZGV2JA",
        secret_key: "sk_live_picked",
      },
    ];
    mockFetchApplication.mockResolvedValue({
      application_id: "app_picked",
      name: "Picked",
      instances,
    });
    mockSelect.mockResolvedValue("ins_prod");

    const ctx = await resolveUsersInstanceContext({});

    expect(mockSelect).toHaveBeenCalledTimes(1);
    // The picker renders a nested tree via buildInstancePickerChoices; recompute
    // the expected choices the same way instead of hardcoding a time-dependent label.
    expect(mockSelect.mock.calls[0]?.[0]).toMatchObject({
      message: "Select an instance to use:",
      choices: buildInstancePickerChoices(instances, Date.now()),
    });
    expect(ctx.secretKey).toBe("sk_live_picked");
    expect(ctx.instanceId).toBe("ins_prod");
    expect(ctx.instanceLabel).toBe("production");
  });

  test("does not prompt for an instance when --instance is passed alongside the app picker", async () => {
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
        {
          instance_id: "ins_prod",
          environment_type: "production",
          publishable_key: "pk_live_aWRlYWwtbG91c2UtNjEuY2xlcmsuYWNjb3VudHMuZGV2JA",
          secret_key: "sk_live_picked",
        },
      ],
    });

    const ctx = await resolveUsersInstanceContext({ instance: "production" });

    expect(mockSelect).not.toHaveBeenCalled();
    expect(ctx.instanceId).toBe("ins_prod");
    expect(ctx.instanceLabel).toBe("production");
  });

  test("prompts even when the app comes from a linked profile", async () => {
    mockResolveAppContext.mockResolvedValue({
      appId: "app_linked",
      appLabel: "Linked",
      instanceId: "ins_dev",
      instanceLabel: "development",
    });
    mockFetchApplication.mockResolvedValue({
      application_id: "app_linked",
      name: "Linked",
      instances: [
        {
          instance_id: "ins_dev",
          environment_type: "development",
          publishable_key: "pk_test_aWRlYWwtbG91c2UtNjEuY2xlcmsuYWNjb3VudHMuZGV2JA",
          secret_key: "sk_test_linked",
        },
        {
          instance_id: "ins_prod",
          environment_type: "production",
          publishable_key: "pk_live_aWRlYWwtbG91c2UtNjEuY2xlcmsuYWNjb3VudHMuZGV2JA",
          secret_key: "sk_live_linked",
        },
      ],
    });
    mockSelect.mockResolvedValue("ins_prod");

    const ctx = await resolveUsersInstanceContext({});

    expect(mockSelect).toHaveBeenCalledTimes(1);
    expect(ctx.instanceId).toBe("ins_prod");
    expect(ctx.instanceLabel).toBe("production");
    expect(ctx.secretKey).toBe("sk_live_linked");
  });

  test("errors in agent mode when the app has multiple instances and no --instance", async () => {
    mockIsHuman.mockReturnValue(false);
    mockResolveAppContext.mockResolvedValue({
      appId: "app_linked",
      appLabel: "Linked",
      instanceId: "ins_dev",
      instanceLabel: "development",
    });
    mockFetchApplication.mockResolvedValue({
      application_id: "app_linked",
      name: "Linked",
      instances: [
        {
          instance_id: "ins_dev",
          environment_type: "development",
          publishable_key: "pk_test_aWRlYWwtbG91c2UtNjEuY2xlcmsuYWNjb3VudHMuZGV2JA",
          secret_key: "sk_test_linked",
        },
        {
          instance_id: "ins_prod",
          environment_type: "production",
          publishable_key: "pk_live_aWRlYWwtbG91c2UtNjEuY2xlcmsuYWNjb3VudHMuZGV2JA",
          secret_key: "sk_live_linked",
        },
      ],
    });

    await expect(resolveUsersInstanceContext({})).rejects.toThrow(/multiple instances/);
    expect(mockSelect).not.toHaveBeenCalled();
  });

  test("agent mode resolves without prompting when the app has a single instance", async () => {
    mockIsHuman.mockReturnValue(false);
    mockResolveAppContext.mockResolvedValue({
      appId: "app_linked",
      appLabel: "Linked",
      instanceId: "ins_dev",
      instanceLabel: "development",
    });
    mockFetchApplication.mockResolvedValue({
      application_id: "app_linked",
      name: "Linked",
      instances: [
        {
          instance_id: "ins_dev",
          environment_type: "development",
          publishable_key: "pk_test_aWRlYWwtbG91c2UtNjEuY2xlcmsuYWNjb3VudHMuZGV2JA",
          secret_key: "sk_test_linked",
        },
      ],
    });

    const ctx = await resolveUsersInstanceContext({});

    expect(mockSelect).not.toHaveBeenCalled();
    expect(ctx.instanceId).toBe("ins_dev");
  });

  test("re-throws NOT_LINKED in agent mode without invoking picker", async () => {
    mockIsHuman.mockReturnValue(false);
    mockResolveAppContext.mockRejectedValue(
      new CliError("No Clerk project linked", { code: ERROR_CODE.NOT_LINKED }),
    );

    await expect(resolveUsersInstanceContext({})).rejects.toThrow(CliError);
    expect(mockPickOrCreateApp).not.toHaveBeenCalled();
  });

  test("resolves the current instance from BAPI when --secret-key and --app are provided", async () => {
    stubFetch(
      async () =>
        new Response(
          JSON.stringify({
            id: "ins_dev",
            publishable_key: "pk_test_aWRlYWwtbG91c2UtNjEuY2xlcmsuYWNjb3VudHMuZGV2JA",
          }),
          { status: 200 },
        ),
    );

    const ctx = await resolveUsersInstanceContext({ secretKey: "sk_test_raw", app: "app_123" });

    expect(ctx.secretKey).toBe("sk_test_raw");
    expect(ctx.appId).toBe("app_123");
    expect(ctx.appLabel).toBe("app_123");
    expect(ctx.instanceId).toBe("ins_dev");
    expect(ctx.instanceLabel).toBe("development");
    expect(ctx.publishableKey).toBe("pk_test_aWRlYWwtbG91c2UtNjEuY2xlcmsuYWNjb3VudHMuZGV2JA");
    expect(ctx.fapiHost).toBe("ideal-louse-61.clerk.accounts.dev");
    expect(mockFetchApplication).not.toHaveBeenCalled();
    expect(mockResolveAppContext).not.toHaveBeenCalled();
  });

  test("rejects a mismatched --instance when --secret-key already targets another instance", async () => {
    stubFetch(
      async () =>
        new Response(
          JSON.stringify({
            id: "ins_dev",
            publishable_key: "pk_test_aWRlYWwtbG91c2UtNjEuY2xlcmsuYWNjb3VudHMuZGV2JA",
          }),
          { status: 200 },
        ),
    );

    await expect(
      resolveUsersInstanceContext({ secretKey: "sk_test_raw", instance: "prod" }),
    ).rejects.toThrow(/does not match the supplied --secret-key/);
  });

  test("resolves the branch without prompting", async () => {
    mockFetchApplication.mockResolvedValue({
      application_id: "app_1",
      name: "App",
      instances: [
        {
          instance_id: "ins_dev",
          environment_type: "development",
          publishable_key: "pk_test_aWRlYWwtbG91c2UtNjEuY2xlcmsuYWNjb3VudHMuZGV2JA",
          secret_key: "sk_dev",
        },
        {
          instance_id: "ins_b",
          environment_type: "development",
          publishable_key: "pk_test_aWRlYWwtbG91c2UtNjEuY2xlcmsuYWNjb3VudHMuZGV2JA",
          secret_key: "sk_branch",
          branch_name: "pr-9",
          parent_instance_id: "ins_dev",
        },
      ],
    });

    const ctx = await resolveUsersInstanceContext({ app: "app_1", branch: "pr-9" });

    expect(mockSelect).not.toHaveBeenCalled();
    expect(ctx.secretKey).toBe("sk_branch");
    expect(ctx.instanceLabel).toBe("pr-9");
  });

  test("--branch + --secret-key errors", async () => {
    await expect(
      resolveUsersInstanceContext({ branch: "pr-9", secretKey: "sk_test_x" }),
    ).rejects.toThrow(/Cannot combine --branch and --secret-key/);
  });

  test("--branch + --instance errors", async () => {
    await expect(
      resolveUsersInstanceContext({ app: "app_1", branch: "pr-9", instance: "dev" }),
    ).rejects.toThrow(/Cannot combine --branch and --instance/);
  });
});
