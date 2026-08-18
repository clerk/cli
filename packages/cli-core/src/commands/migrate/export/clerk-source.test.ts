import { beforeEach, describe, expect, mock, test } from "bun:test";
import { CliError, ERROR_CODE, UserAbortError } from "../../../lib/errors.ts";
import { useCaptureLog } from "../../../test/lib/stubs.ts";

const mockDescribeBapiTarget = mock();
const mockResolveBapiSecretKey = mock();
mock.module("../../../lib/bapi-command.ts", () => ({
  describeBapiTarget: (...args: unknown[]) => mockDescribeBapiTarget(...args),
  resolveBapiSecretKey: (...args: unknown[]) => mockResolveBapiSecretKey(...args),
}));

const mockResolveProfile = mock();
mock.module("../../../lib/config.ts", () => ({
  resolveProfile: (...args: unknown[]) => mockResolveProfile(...args),
}));

const mockFetchApps = mock();
mock.module("../../../lib/app-picker.ts", () => ({
  fetchAppsTolerantly: (...args: unknown[]) => mockFetchApps(...args),
}));

const mockSearch = mock();
mock.module("../../../lib/listage.ts", () => ({
  search: (...args: unknown[]) => mockSearch(...args),
}));

const mockResolveUsersInstanceContext = mock();
mock.module("../../users/interactive/instance-context.ts", () => ({
  resolveUsersInstanceContext: (...args: unknown[]) => mockResolveUsersInstanceContext(...args),
}));

let human = true;
mock.module("../../../mode.ts", () => ({
  isHuman: () => human,
  isAgent: () => !human,
  getMode: () => (human ? "human" : "agent"),
  setMode: () => {},
}));

const { resolveClerkSource } = await import("./clerk-source.ts");

const captured = useCaptureLog();

beforeEach(() => {
  human = true;
  mockDescribeBapiTarget.mockReset();
  mockResolveBapiSecretKey.mockReset();
  mockResolveProfile.mockReset();
  mockResolveProfile.mockResolvedValue(undefined);
  mockResolveUsersInstanceContext.mockReset();
  mockFetchApps.mockReset();
  mockSearch.mockReset();
  delete process.env.CLERK_SECRET_KEY;
});

/** The linked-project case: something resolved, nobody asked for it. */
function stubResolved(target: string | undefined, secretKey = "sk_test_resolved") {
  mockDescribeBapiTarget.mockResolvedValue(target);
  mockResolveBapiSecretKey.mockResolvedValue(secretKey);
}

describe("resolveClerkSource", () => {
  test("--secret-key names the instance outright and is never questioned", async () => {
    stubResolved(undefined, "sk_test_explicit");

    const source = await resolveClerkSource({ secretKey: "sk_test_explicit" });

    expect(source).toEqual({ secretKey: "sk_test_explicit", target: undefined });
    expect(mockSearch).not.toHaveBeenCalled();
  });

  // Exporting the instance that is about to be imported *into* is the failure
  // this whole module exists to prevent, so a resolved instance is offered as
  // one choice among the account's applications rather than taken silently.
  test("offers every instance, flat, with the linked application's first", async () => {
    stubResolved("my-app (development)");
    mockResolveProfile.mockResolvedValue({ profile: { appId: "app_2" } });
    mockFetchApps.mockResolvedValue([
      {
        application_id: "app_1",
        name: "my-app",
        instances: [
          { instance_id: "ins_1d", environment_type: "development" },
          { instance_id: "ins_1p", environment_type: "production" },
        ],
      },
      {
        application_id: "app_2",
        name: "other-app",
        instances: [{ instance_id: "ins_2d", environment_type: "development" }],
      },
    ]);
    mockSearch.mockResolvedValue({ app: "app_1", instance: "ins_1p" });
    mockResolveUsersInstanceContext.mockResolvedValue({
      secretKey: "sk_live_other",
      appLabel: "my-app",
      instanceLabel: "production",
    });

    const source = await resolveClerkSource({});

    expect(source).toEqual({ secretKey: "sk_live_other", target: "my-app (production)" });
    // One row per instance, not per application: dev and prod are different
    // user pools, and exporting the wrong one is silent.
    const { message, source: listSource } = mockSearch.mock.calls[0]![0];
    expect(message).toBe("What Clerk instance do you want to export users from?");
    expect(listSource("")).toEqual([
      {
        name: "other-app - Development instance (ins_2d)",
        value: { app: "app_2", instance: "ins_2d" },
      },
      {
        name: "my-app - Development instance (ins_1d)",
        value: { app: "app_1", instance: "ins_1d" },
      },
      {
        name: "my-app - Production instance (ins_1p)",
        value: { app: "app_1", instance: "ins_1p" },
      },
    ]);
    // Both halves are handed on, so the secret-key lookup runs against exactly
    // the instance that was chosen and nothing prompts a second time.
    expect(mockResolveUsersInstanceContext).toHaveBeenCalledWith({
      app: "app_1",
      instance: "ins_1p",
    });
    expect(captured.err).toBe("");
  });

  // The list is searched by its rendered label, so an application id typed from
  // a dashboard URL still finds its instances.
  test("filters on the rendered label", async () => {
    stubResolved("my-app (development)");
    mockFetchApps.mockResolvedValue([
      {
        application_id: "app_1",
        name: "my-app",
        instances: [{ instance_id: "ins_1p", environment_type: "production" }],
      },
      {
        application_id: "app_2",
        name: "other-app",
        instances: [{ instance_id: "ins_2d", environment_type: "development" }],
      },
    ]);
    mockSearch.mockResolvedValue({ app: "app_1", instance: "ins_1p" });
    mockResolveUsersInstanceContext.mockResolvedValue({ secretKey: "sk_live_other" });

    await resolveClerkSource({});

    const { source: listSource } = mockSearch.mock.calls[0]![0];
    expect(listSource("ins_2d")).toEqual([
      {
        name: "other-app - Development instance (ins_2d)",
        value: { app: "app_2", instance: "ins_2d" },
      },
    ]);
    expect(listSource("production")).toHaveLength(1);
  });

  // An empty list is not a picker. PLAPI being degraded looks the same as an
  // account with no applications, and neither one has an instance to offer.
  test("no instances to offer falls back to the flags", async () => {
    stubResolved("my-app (development)");
    // An application with no instances is not an offer either.
    mockFetchApps.mockResolvedValue([{ application_id: "app_1", name: "my-app", instances: [] }]);

    await expect(resolveClerkSource({})).rejects.toBeInstanceOf(UserAbortError);

    expect(mockSearch).not.toHaveBeenCalled();
    expect(captured.err).toContain("--secret-key");
    expect(captured.err).toContain("--app");
    expect(captured.err).toContain("clerk link");
  });

  test("agent mode takes the resolved instance without prompting", async () => {
    human = false;
    stubResolved("my-app (production)");

    const source = await resolveClerkSource({});

    expect(source.secretKey).toBe("sk_test_resolved");
    expect(mockSearch).not.toHaveBeenCalled();
  });

  test("an unlinked directory picks an application instead of failing", async () => {
    mockDescribeBapiTarget.mockRejectedValue(
      new CliError("No secret key found.", { code: ERROR_CODE.NO_SECRET_KEY }),
    );
    mockResolveUsersInstanceContext.mockResolvedValue({
      secretKey: "sk_test_picked",
      appLabel: "other-app",
      instanceLabel: "production",
    });

    const source = await resolveClerkSource({});

    expect(source).toEqual({ secretKey: "sk_test_picked", target: "other-app (production)" });
    // The picker just asked which application; asking again is noise.
    expect(mockSearch).not.toHaveBeenCalled();
  });

  test("an explicit --app that fails to resolve surfaces the error, not the picker", async () => {
    const failure = new CliError("No secret key found.", { code: ERROR_CODE.NO_SECRET_KEY });
    mockDescribeBapiTarget.mockRejectedValue(failure);

    await expect(resolveClerkSource({ app: "app_123" })).rejects.toThrow(failure);

    expect(mockResolveUsersInstanceContext).not.toHaveBeenCalled();
  });
});
