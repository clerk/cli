import { describe, expect, test } from "bun:test";
import { mapDeployError } from "./errors.ts";
import { CliError, ERROR_CODE, PlapiError } from "../../lib/errors.ts";

const planError = (meta?: Record<string, unknown>) =>
  new PlapiError(
    402,
    JSON.stringify({
      errors: [
        {
          code: "unsupported_subscription_plan_features",
          message: "unsupported plan features",
          ...(meta ? { meta } : {}),
        },
      ],
    }),
    "https://x",
  );

async function rejectionOf(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("expected promise to reject");
}

describe("mapDeployError", () => {
  test("lists unsupported features from meta.unsupported_features on 402", async () => {
    const error = await rejectionOf(
      mapDeployError(
        Promise.reject(
          planError({ unsupported_features: ["app:allowlist", "app:remove_branding"] }),
        ),
      ),
    );

    expect(error).toBeInstanceOf(CliError);
    const cliError = error as CliError;
    expect(cliError.code).toBe(ERROR_CODE.PLAN_INSUFFICIENT);
    expect(cliError.docsUrl).toBe("https://clerk.com/pricing");
    expect(cliError.message).toContain("• app:allowlist");
    expect(cliError.message).toContain("• app:remove_branding");
    expect(cliError.message).not.toContain("doesn't cover all the features");
  });

  test("falls back to the generic plan message when unsupported_features is empty", async () => {
    const error = await rejectionOf(
      mapDeployError(Promise.reject(planError({ unsupported_features: [] }))),
    );

    expect(error).toBeInstanceOf(CliError);
    const cliError = error as CliError;
    expect(cliError.code).toBe(ERROR_CODE.PLAN_INSUFFICIENT);
    expect(cliError.message).toContain("doesn't cover all the features");
    expect(cliError.message).not.toContain("•");
  });
});
