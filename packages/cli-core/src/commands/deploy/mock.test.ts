import { test, expect, describe } from "bun:test";
import type { Application } from "../../lib/plapi.ts";
import { PlapiError } from "../../lib/errors.ts";
import {
  resolveTestDeployFlags,
  withMockProductionInstance,
  withTestFailureAfterApiCall,
} from "./mock.ts";

describe("resolveTestDeployFlags", () => {
  test("normalizes every undefined flag to false", () => {
    expect(resolveTestDeployFlags({})).toEqual({
      testForceProductionInstance: false,
      testFailProductionInstanceCheck: false,
      testFailDomainLookup: false,
      testFailValidateCloning: false,
      testFailCreateProductionInstance: false,
      testFailDnsVerification: false,
      testFailOAuthSave: false,
    });
  });

  test("preserves true flags and leaves siblings false", () => {
    expect(
      resolveTestDeployFlags({
        testForceProductionInstance: true,
        testFailDnsVerification: true,
      }),
    ).toEqual({
      testForceProductionInstance: true,
      testFailProductionInstanceCheck: false,
      testFailDomainLookup: false,
      testFailValidateCloning: false,
      testFailCreateProductionInstance: false,
      testFailDnsVerification: true,
      testFailOAuthSave: false,
    });
  });

  test("coerces non-true truthy values to false (strict identity check)", () => {
    // The implementation uses `=== true`, so anything other than literal `true`
    // (including a stray non-boolean leaking through the option parser) must
    // normalize to false rather than be passed through.
    const result = resolveTestDeployFlags({
      testForceProductionInstance: 1 as unknown as boolean,
      testFailOAuthSave: "yes" as unknown as boolean,
    });
    expect(result.testForceProductionInstance).toBe(false);
    expect(result.testFailOAuthSave).toBe(false);
  });
});

describe("withTestFailureAfterApiCall", () => {
  test("resolves with the awaited value when shouldFail is falsy", async () => {
    await expect(withTestFailureAfterApiCall(Promise.resolve("ok"), false, "step")).resolves.toBe(
      "ok",
    );
    await expect(
      withTestFailureAfterApiCall(Promise.resolve("ok"), undefined, "step"),
    ).resolves.toBe("ok");
  });

  test("awaits the promise before throwing when shouldFail is true", async () => {
    let resolved = false;
    const pending = (async () => {
      await Promise.resolve();
      resolved = true;
      return "value";
    })();

    await expect(
      withTestFailureAfterApiCall(pending, true, "production instance check"),
    ).rejects.toBeInstanceOf(PlapiError);
    expect(resolved).toBe(true);
  });

  test("throws a PlapiError carrying the step in its message", async () => {
    let error: unknown;
    try {
      await withTestFailureAfterApiCall(Promise.resolve(null), true, "DNS verification");
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(PlapiError);
    expect((error as Error).message).toContain("Simulated deploy failure: DNS verification.");
  });

  test("does not swallow rejections from the upstream promise", async () => {
    const upstreamFailure = new Error("upstream boom");
    await expect(
      withTestFailureAfterApiCall(Promise.reject(upstreamFailure), true, "step"),
    ).rejects.toBe(upstreamFailure);
  });
});

describe("withMockProductionInstance", () => {
  function app(instances: Application["instances"]): Application {
    return {
      application_id: "app_xyz789",
      name: "my-saas-app",
      instances,
    };
  }

  test("returns the input unchanged when a production instance already exists", () => {
    const existing = app([
      {
        instance_id: "ins_dev_123",
        environment_type: "development",
        publishable_key: "pk_test_123",
      },
      {
        instance_id: "ins_prod_real",
        environment_type: "production",
        publishable_key: "pk_live_real",
      },
    ]);

    const result = withMockProductionInstance(existing);
    expect(result).toBe(existing);
    expect(result.instances).toBe(existing.instances);
  });

  test("appends a mock production instance when none is present", () => {
    const devOnly = app([
      {
        instance_id: "ins_dev_123",
        environment_type: "development",
        publishable_key: "pk_test_123",
      },
    ]);

    const result = withMockProductionInstance(devOnly);

    // Original input is not mutated.
    expect(devOnly.instances).toHaveLength(1);
    expect(result).not.toBe(devOnly);
    expect(result.instances).toHaveLength(2);
    expect(result.instances[0]).toEqual(devOnly.instances[0]!);
    expect(result.instances[1]).toEqual({
      instance_id: "ins_prod_mock",
      environment_type: "production",
      publishable_key: "pk_live_test",
    });
  });

  test("appends production even when only non-development instances exist", () => {
    const stagingOnly = app([
      {
        instance_id: "ins_staging_123",
        environment_type: "staging",
        publishable_key: "pk_staging_123",
      },
    ]);

    const result = withMockProductionInstance(stagingOnly);
    expect(result.instances).toHaveLength(2);
    expect(result.instances.some((instance) => instance.environment_type === "production")).toBe(
      true,
    );
  });
});
