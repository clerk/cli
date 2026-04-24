import { test, expect, describe, beforeEach, mock } from "bun:test";

const mockResolveContext = mock();
const mockFetchUserSettings = mock();
const mockBootstrapDevBrowser = mock();
const mockInput = mock();
const mockPassword = mock();

mock.module("./interactive/instance-context.ts", () => ({
  resolveUsersInstanceContext: (...args: unknown[]) => mockResolveContext(...args),
}));
mock.module("../../lib/fapi.ts", () => ({
  fetchUserSettings: (...args: unknown[]) => mockFetchUserSettings(...args),
  bootstrapDevBrowser: (...args: unknown[]) => mockBootstrapDevBrowser(...args),
  decodePublishableKey: (pk: string) => ({
    fapiHost: "fake.example.com",
    instanceType: pk.startsWith("pk_test_") ? "development" : "production",
  }),
}));
mock.module("@inquirer/prompts", () => ({
  input: (...args: unknown[]) => mockInput(...args),
  password: (...args: unknown[]) => mockPassword(...args),
}));
mock.module("../../lib/spinner.ts", () => ({
  withSpinner: async (_msg: string, fn: () => Promise<unknown>) => fn(),
  intro: () => {},
  outro: () => {},
  bar: () => {},
}));

const { runCreateWizard } = await import("./create-wizard.ts");

describe("runCreateWizard", () => {
  beforeEach(() => {
    mockResolveContext.mockReset();
    mockFetchUserSettings.mockReset();
    mockBootstrapDevBrowser.mockReset();
    mockInput.mockReset();
    mockPassword.mockReset();
  });

  test("only prompts for enabled attributes (FAPI-driven)", async () => {
    mockResolveContext.mockResolvedValue({
      secretKey: "sk_test_xyz",
      publishableKey: "pk_test_xyz",
      fapiHost: "fake.example.com",
    });
    mockBootstrapDevBrowser.mockResolvedValue("jwt-abc");
    mockFetchUserSettings.mockResolvedValue({
      attributes: {
        email_address: { enabled: true, required: true, used_for_first_factor: true },
        password: { enabled: true, required: true, used_for_first_factor: false },
        username: { enabled: false, required: false, used_for_first_factor: false },
        first_name: { enabled: true, required: false, used_for_first_factor: false },
      },
    });
    mockInput.mockResolvedValueOnce("alice@example.com").mockResolvedValueOnce("Alice");
    mockPassword.mockResolvedValueOnce("Password123");

    const result = await runCreateWizard({});

    expect(result).toEqual({
      email: "alice@example.com",
      password: "Password123",
      firstName: "Alice",
    });
    // username was disabled — never prompted
    expect(mockInput).toHaveBeenCalledTimes(2);
    expect(mockPassword).toHaveBeenCalledTimes(1);
  });

  test("falls back to optional curated set when no publishable key resolvable", async () => {
    mockResolveContext.mockResolvedValue({ secretKey: "sk_test_raw" });
    mockInput.mockResolvedValue("");
    mockPassword.mockResolvedValue("");

    const result = await runCreateWizard({ secretKey: "sk_test_raw" });
    expect(result).toEqual({});
    expect(mockBootstrapDevBrowser).not.toHaveBeenCalled();
    expect(mockFetchUserSettings).not.toHaveBeenCalled();
  });

  test("skips dev_browser bootstrap on production instance", async () => {
    mockResolveContext.mockResolvedValue({
      secretKey: "sk_live_xyz",
      publishableKey: "pk_live_xyz",
      fapiHost: "clerk.example.com",
    });
    mockFetchUserSettings.mockResolvedValue({
      attributes: { email_address: { enabled: true, required: false } },
    });
    mockInput.mockResolvedValueOnce("");

    await runCreateWizard({});
    expect(mockBootstrapDevBrowser).not.toHaveBeenCalled();
    expect(mockFetchUserSettings).toHaveBeenCalledWith("clerk.example.com", {});
  });
});
