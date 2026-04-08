import { test, expect, describe, mock } from "bun:test";
import { create } from "./create.ts";
import { testRoot } from "../../test/lib/test-root.ts";

const mockCreatedApp = {
  application_id: "app_abc123",
  name: "My SaaS App",
};

const mockFetchedApp = {
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

type DepsOverrides = {
  isAgent?: boolean;
  createApplication?: (name: string) => Promise<unknown>;
  fetchApplication?: (id: string) => Promise<unknown>;
};

function depsFor(overrides: DepsOverrides = {}) {
  const agent = overrides.isAgent ?? false;
  return testRoot({
    plapi: {
      createApplication: overrides.createApplication ?? (async () => mockCreatedApp as never),
      fetchApplication: overrides.fetchApplication ?? (async () => mockFetchedApp as never),
    },
    mode: {
      isAgent: () => agent,
    },
  });
}

function dataCalls(deps: { log: { data: unknown } }): string[] {
  return ((deps.log.data as ReturnType<typeof mock>).mock.calls as unknown[][]).map((c) =>
    String(c[0] ?? ""),
  );
}
function successCalls(deps: { log: { success: unknown } }): string[] {
  return ((deps.log.success as ReturnType<typeof mock>).mock.calls as unknown[][]).map((c) =>
    String(c[0] ?? ""),
  );
}

describe("apps create", () => {
  test("calls createApplication then fetchApplication", async () => {
    const createFn = mock(async (_name: string) => mockCreatedApp as never);
    const fetchFn = mock(async (_id: string) => mockFetchedApp as never);
    const deps = depsFor({ createApplication: createFn, fetchApplication: fetchFn });

    await create(deps, "My SaaS App");

    expect(createFn).toHaveBeenCalledWith("My SaaS App");
    expect(fetchFn).toHaveBeenCalledWith("app_abc123");
  });

  describe("human output", () => {
    test("shows created app name and id", async () => {
      const deps = depsFor();
      await create(deps, "My SaaS App");

      const output = successCalls(deps).join("\n");
      expect(output).toContain("Created");
      expect(output).toContain("My SaaS App");
      expect(output).toContain("app_abc123");
    });

    test("falls back to app id when name is absent", async () => {
      const deps = depsFor({
        createApplication: async () => ({ application_id: "app_noname" }) as never,
        fetchApplication: async () =>
          ({
            application_id: "app_noname",
            instances: [
              {
                instance_id: "ins_1",
                environment_type: "development",
                publishable_key: "pk_test",
              },
            ],
          }) as never,
      });
      await create(deps, "Some Name");

      const output = successCalls(deps).join("\n");
      expect(output).toContain("app_noname");
    });

    test("does not show secret keys", async () => {
      const deps = depsFor();
      await create(deps, "My SaaS App");

      const output = successCalls(deps).join("\n") + dataCalls(deps).join("\n");
      expect(output).not.toContain("sk_test_xxx");
      expect(output).not.toContain("sk_live_xxx");
    });
  });

  describe("JSON output", () => {
    test("outputs JSON when --json flag is set", async () => {
      const deps = depsFor();
      await create(deps, "My SaaS App", { json: true });

      const output = dataCalls(deps)[0]!;
      const parsed = JSON.parse(output);
      expect(parsed.application_id).toBe("app_abc123");
      expect(parsed.name).toBe("My SaaS App");
      expect(parsed.instances).toHaveLength(2);
    });

    test("outputs JSON in agent mode", async () => {
      const deps = depsFor({ isAgent: true });
      await create(deps, "My SaaS App");

      const output = dataCalls(deps)[0]!;
      const parsed = JSON.parse(output);
      expect(parsed.application_id).toBe("app_abc123");
    });

    test("strips secret_key from JSON", async () => {
      const deps = depsFor();
      await create(deps, "My SaaS App", { json: true });

      const output = dataCalls(deps)[0]!;
      const parsed = JSON.parse(output);
      for (const instance of parsed.instances) {
        expect(instance).not.toHaveProperty("secret_key");
        expect(instance).toHaveProperty("publishable_key");
      }
    });
  });

  describe("error handling", () => {
    test("propagates createApplication failure without fetching", async () => {
      let fetchCalled = false;
      const deps = depsFor({
        createApplication: async () => {
          throw new Error("Unprocessable Entity");
        },
        fetchApplication: async () => {
          fetchCalled = true;
          return mockFetchedApp as never;
        },
      });

      await expect(create(deps, "Bad App")).rejects.toThrow("Unprocessable Entity");
      expect(fetchCalled).toBe(false);
    });

    test("propagates fetchApplication failure after create", async () => {
      const deps = depsFor({
        fetchApplication: async () => {
          throw new Error("Service Unavailable");
        },
      });

      await expect(create(deps, "My SaaS App")).rejects.toThrow("Service Unavailable");
    });
  });
});
