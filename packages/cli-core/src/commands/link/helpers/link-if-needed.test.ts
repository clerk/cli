import { test, expect, describe, beforeEach, mock } from "bun:test";
import type { Application } from "../../../lib/plapi.ts";

// `lib/autolink.ts` is imported directly by both index.ts and the helper.
// Mock it at file top so the helper-level branches can be exercised without
// touching the real env-file scanner.
const mockAutolink = mock();
const mockFindClerkKeys = mock();
const mockMatchKeyToApp = mock();
mock.module("../../../lib/autolink.ts", () => ({
  autolink: (...args: unknown[]) => mockAutolink(...args),
  findClerkKeys: (...args: unknown[]) => mockFindClerkKeys(...args),
  matchKeyToApp: (...args: unknown[]) => mockMatchKeyToApp(...args),
}));

const { linkIfNeeded } = await import("./link-if-needed.ts");
const { testRoot } = await import("../../../test/lib/test-root.ts");

const MOCK_APP: Application = {
  application_id: "app_xyz",
  instances: [
    {
      instance_id: "ins_dev",
      environment_type: "development",
      secret_key: "sk_test",
      publishable_key: "pk_test",
    },
  ],
};

const HUMAN = { isAgent: () => false, isHuman: () => true } as const;

function baseDeps(overrides?: Parameters<typeof testRoot>[0]) {
  return testRoot({
    mode: HUMAN,
    env: { get: () => "platform_key" },
    git: {
      getGitRepoRoot: async () => "/repo",
      getGitNormalizedRemote: async () => "github.com/org/repo",
      getGitRepoIdentifier: async () => "/repo/.git",
    },
    configStore: {
      resolveProfile: async () => undefined,
      setProfile: async () => {},
      moveProfile: async () => {},
    },
    plapi: {
      fetchApplication: async () => MOCK_APP,
      listApplications: async () => [MOCK_APP],
    },
    ...overrides,
  });
}

describe("linkIfNeeded", () => {
  beforeEach(() => {
    mockAutolink.mockReset();
    mockAutolink.mockResolvedValue(undefined);
    mockFindClerkKeys.mockReset();
    mockFindClerkKeys.mockResolvedValue([]);
    mockMatchKeyToApp.mockReset();
    mockMatchKeyToApp.mockReturnValue(undefined);
  });

  test("returns linked=true with existing appId when profile exists", async () => {
    const deps = baseDeps({
      configStore: {
        resolveProfile: async () => ({
          path: "github.com/org/repo",
          profile: {
            workspaceId: "",
            appId: "app_existing",
            instances: { development: "ins_1" },
          },
        }),
      },
    });

    const result = await linkIfNeeded(deps);

    expect(result).toEqual({ linked: true, appId: "app_existing" });
    expect(mockAutolink).not.toHaveBeenCalled();
    expect(deps.plapi.listApplications).not.toHaveBeenCalled();
    expect(deps.configStore.setProfile).not.toHaveBeenCalled();
  });

  test("prints existing status via deps.log.info when already linked", async () => {
    const deps = baseDeps({
      configStore: {
        resolveProfile: async () => ({
          path: "/repo/.git",
          profile: {
            workspaceId: "",
            appId: "app_existing",
            instances: { development: "ins_1" },
          },
        }),
      },
    });

    await linkIfNeeded(deps);

    const messages = (deps.log.info as ReturnType<typeof mock>).mock.calls.map(
      (c) => c[0] as string,
    );
    expect(messages.some((m) => m.includes("Already linked"))).toBe(true);
  });

  test("attempts autolink when no profile and no --app provided", async () => {
    mockAutolink.mockResolvedValue({
      path: "github.com/org/repo",
      profile: { workspaceId: "", appId: "app_auto", instances: { development: "ins_1" } },
    });
    const deps = baseDeps();

    const result = await linkIfNeeded(deps);

    expect(mockAutolink).toHaveBeenCalled();
    expect(result).toEqual({ linked: true, appId: "app_auto" });
    expect(deps.plapi.listApplications).not.toHaveBeenCalled();
  });

  test("skips autolink when --app is provided", async () => {
    const deps = baseDeps();

    await linkIfNeeded(deps, { app: "app_xyz" });

    expect(mockAutolink).not.toHaveBeenCalled();
    expect(deps.plapi.fetchApplication).toHaveBeenCalledWith("app_xyz");
    expect(deps.configStore.setProfile).toHaveBeenCalled();
  });

  test("falls through to interactive link flow when no profile and autolink fails", async () => {
    mockAutolink.mockResolvedValue(undefined);
    const deps = baseDeps({
      prompts: { search: async () => "app_xyz", confirm: async () => false },
      plapi: {
        fetchApplication: async () => MOCK_APP,
        listApplications: async () => [MOCK_APP],
      },
    });

    const result = await linkIfNeeded(deps);

    expect(mockAutolink).toHaveBeenCalled();
    expect(deps.plapi.listApplications).toHaveBeenCalled();
    expect(deps.configStore.setProfile).toHaveBeenCalled();
    expect(result).toEqual({ linked: true, appId: "app_xyz" });
  });

  test("propagates errors from underlying link flow (no dev instance)", async () => {
    const prodOnly: Application = {
      application_id: "app_prod_only",
      instances: [
        {
          instance_id: "ins_prod",
          environment_type: "production",
          secret_key: "sk_live",
          publishable_key: "pk_live",
        },
      ],
    };
    const deps = baseDeps({
      plapi: {
        fetchApplication: async () => prodOnly,
        listApplications: async () => [prodOnly],
      },
    });

    await expect(linkIfNeeded(deps, { app: "app_prod_only" })).rejects.toThrow(
      "Application has no development instance",
    );
  });
});
