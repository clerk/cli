import { test, expect, describe, beforeEach, afterEach, spyOn } from "bun:test";
import { CliError } from "../../lib/errors.ts";

const configModule = await import("../../lib/config.ts");
const plapiModule = await import("../../lib/plapi.ts");

const { resolveFapiHost } = await import("./fapi.ts");

describe("resolveFapiHost", () => {
  let resolveAppContextSpy: ReturnType<typeof spyOn>;
  let fetchApplicationSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    resolveAppContextSpy = spyOn(configModule, "resolveAppContext");
    fetchApplicationSpy = spyOn(plapiModule, "fetchApplication");
  });

  afterEach(() => {
    resolveAppContextSpy.mockRestore();
    fetchApplicationSpy.mockRestore();
  });

  test("resolves the fapi host from an explicit app and instance", async () => {
    fetchApplicationSpy.mockResolvedValue({
      application_id: "app_1",
      instances: [
        {
          instance_id: "ins_dev",
          environment_type: "development",
          publishable_key: "pk_test_Zm9vLmNsZXJrLmFjY291bnRzLmRldiQ",
        },
      ],
    });

    await expect(resolveFapiHost({ app: "app_1", instance: "dev" })).resolves.toBe(
      "foo.clerk.accounts.dev",
    );

    expect(resolveAppContextSpy).not.toHaveBeenCalled();
  });

  test("rejects --branch combined with --instance before resolving an app, mirroring the linked-profile guard", async () => {
    fetchApplicationSpy.mockResolvedValue({
      application_id: "app_1",
      instances: [
        {
          instance_id: "ins_dev",
          environment_type: "development",
          publishable_key: "pk_test_Zm9vLmNsZXJrLmFjY291bnRzLmRldiQ",
        },
      ],
    });

    const error = await resolveFapiHost({ app: "app_1", instance: "prod", branch: "pr-9" }).catch(
      (error_) => error_,
    );

    expect(error).toBeInstanceOf(CliError);
    expect(error.message).toBe(
      "Cannot combine --branch and --instance. Pass only one to select an instance.",
    );
    expect(fetchApplicationSpy).not.toHaveBeenCalled();
    expect(resolveAppContextSpy).not.toHaveBeenCalled();
  });
});
