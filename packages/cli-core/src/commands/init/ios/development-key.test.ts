import { afterEach, describe, expect, spyOn, test } from "bun:test";
import * as plapi from "../../../lib/plapi.ts";
import { resolveIOSDevelopmentPublicKey } from "./development-key.ts";

const spies: Array<{ mockRestore(): void }> = [];

afterEach(() => {
  for (const spy of spies.splice(0)) spy.mockRestore();
});

describe("iOS development publishable-key resolution", () => {
  test("fetches an exact application without secret keys and selects its development instance", async () => {
    const fetchApplication = spyOn(plapi, "fetchApplication").mockResolvedValue({
      application_id: "app_native",
      instances: [
        {
          instance_id: "ins_production",
          environment_type: "production",
          publishable_key: "pk_live_redacted",
          secret_key: "sk_live_must_not_escape",
        },
        {
          instance_id: "ins_development",
          environment_type: "development",
          publishable_key: "pk_test_redacted",
          secret_key: "sk_test_must_not_escape",
        },
      ],
    });
    spies.push(fetchApplication);

    const resolved = await resolveIOSDevelopmentPublicKey("app_native");

    expect(fetchApplication).toHaveBeenCalledWith("app_native", { includeSecretKeys: false });
    expect(resolved).toEqual({
      applicationId: "app_native",
      instanceId: "ins_development",
      publishableKey: "pk_test_redacted",
    });
    expect(resolved).not.toHaveProperty("secretKey");
  });

  test("requires the exact application to have a development instance", async () => {
    const fetchApplication = spyOn(plapi, "fetchApplication").mockResolvedValue({
      application_id: "app_production_only",
      instances: [
        {
          instance_id: "ins_production",
          environment_type: "production",
          publishable_key: "pk_live_redacted",
        },
      ],
    });
    spies.push(fetchApplication);

    await expect(resolveIOSDevelopmentPublicKey("app_production_only")).rejects.toThrow(
      "No development instance found",
    );
  });

  test("returns the fetched application identity for the commit-time stale check", async () => {
    const fetchApplication = spyOn(plapi, "fetchApplication").mockResolvedValue({
      application_id: "app_changed",
      instances: [
        {
          instance_id: "ins_development",
          environment_type: "development",
          publishable_key: "pk_test_redacted",
        },
      ],
    });
    spies.push(fetchApplication);

    const resolved = await resolveIOSDevelopmentPublicKey("app_requested");

    expect(resolved.applicationId).toBe("app_changed");
  });
});
