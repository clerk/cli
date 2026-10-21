import { beforeEach, describe, expect, mock, test } from "bun:test";
import { CliError, ERROR_CODE, EXIT_CODE, UserAbortError } from "../../../lib/errors.ts";
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

const mockConfirm = mock();
mock.module("../../../lib/prompts.ts", () => ({
  confirm: (...args: unknown[]) => mockConfirm(...args),
}));

let human = true;
mock.module("../../../mode.ts", () => ({
  isHuman: () => human,
  isAgent: () => !human,
  getMode: () => (human ? "human" : "agent"),
  setMode: () => {},
}));

const { resolveClerkSource } = await import("./clerk-source.ts");
const { setAssumeYes } = await import("../lib/assume-yes.ts");

const captured = useCaptureLog();

beforeEach(() => {
  human = true;
  setAssumeYes(false);
  mockDescribeBapiTarget.mockReset();
  mockResolveBapiSecretKey.mockReset();
  mockResolveProfile.mockReset();
  mockResolveProfile.mockResolvedValue(undefined);
  mockResolveUsersInstanceContext.mockReset();
  mockFetchApps.mockReset();
  mockSearch.mockReset();
  mockConfirm.mockReset();
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

  // An export has to be scriptable outside agent mode. Before this, `chosen`
  // keyed off `--secret-key` alone, so every other way of naming an instance
  // still stopped at a picker no flag could answer.
  test.each([
    ["--app", { app: "app_1" }],
    ["--instance", { instance: "prod" }],
    ["--app and --instance", { app: "app_1", instance: "prod" }],
  ])("%s names the instance, so nothing is asked", async (_label, options) => {
    stubResolved("my-app (production)");

    const source = await resolveClerkSource(options);

    expect(source).toEqual({ secretKey: "sk_test_resolved", target: "my-app (production)" });
    expect(mockSearch).not.toHaveBeenCalled();
  });

  // `resolveBapiSecretKey` puts an exported key above the linked profile for
  // every other command in this family. Opening a picker here — and then
  // overriding the key with whatever it returned — made this the one command
  // where exporting CLERK_SECRET_KEY did less than not exporting it.
  test("an exported CLERK_SECRET_KEY is not second-guessed in a linked directory", async () => {
    process.env.CLERK_SECRET_KEY = "sk_test_from_env";
    stubResolved("my-app (development)", "sk_test_from_env");

    const source = await resolveClerkSource({});

    expect(source).toEqual({ secretKey: "sk_test_from_env", target: "my-app (development)" });
    expect(mockSearch).not.toHaveBeenCalled();
  });

  // Exporting the instance that is about to be imported *into* is the failure
  // this whole module exists to prevent, so a resolved instance is offered as
  // one choice among the account's applications rather than taken silently.
  // The linked application is usually the destination, and the first row is
  // what a reflexive Enter takes: it goes last, marked.
  test("offers every instance, flat, with the linked application's last and marked", async () => {
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
        name: "my-app - Development instance (ins_1d)",
        value: { app: "app_1", instance: "ins_1d" },
      },
      {
        name: "my-app - Production instance (ins_1p)",
        value: { app: "app_1", instance: "ins_1p" },
      },
      {
        name: "other-app - Development instance (ins_2d) (linked: usually the destination)",
        value: { app: "app_2", instance: "ins_2d" },
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
  test("no instances to offer is a usage error naming the flags", async () => {
    stubResolved("my-app (development)");
    // An application with no instances is not an offer either.
    mockFetchApps.mockResolvedValue([{ application_id: "app_1", name: "my-app", instances: [] }]);

    const error = (await resolveClerkSource({}).catch((e: unknown) => e)) as CliError;

    expect(error.exitCode).toBe(EXIT_CODE.USAGE);
    expect(error.message).toContain("There are no instances to pick from");
    expect(error.message).toContain("--secret-key");
    expect(error.message).toContain("--app");
    expect(mockSearch).not.toHaveBeenCalled();
  });

  // An accountless app's key is resolved; listing applications needs a login.
  test("offers the resolved instance when applications can't be listed", async () => {
    stubResolved("this accountless application (secret key from .env)");
    mockFetchApps.mockRejectedValue(
      new CliError("Not authenticated. Run `clerk auth login`.", {
        code: ERROR_CODE.AUTH_REQUIRED,
      }),
    );
    mockConfirm.mockResolvedValue(true);

    const source = await resolveClerkSource({});

    expect(source.secretKey).toBe("sk_test_resolved");
    expect(mockConfirm).toHaveBeenCalledTimes(1);
  });

  test("a no to the resolved instance, when applications can't be listed, exports nothing", async () => {
    stubResolved("this accountless application (secret key from .env)");
    mockFetchApps.mockRejectedValue(
      new CliError("Not authenticated. Run `clerk auth login`.", {
        code: ERROR_CODE.AUTH_REQUIRED,
      }),
    );
    mockConfirm.mockResolvedValue(false);

    await expect(resolveClerkSource({})).rejects.toBeInstanceOf(UserAbortError);
  });

  // Nobody to ask, and the resolved instance is usually the destination: an
  // agent would export it and import it straight back.
  test.each([
    [
      "agent mode",
      (): void => {
        human = false;
      },
      {},
    ],
    ["-y", (): void => setAssumeYes(true), {}],
    ["--json", (): void => {}, { json: true }],
  ] as const)(
    "%s refuses the resolved instance, naming the flags",
    async (_label, arrange, options) => {
      stubResolved("my-app (production)");
      arrange();

      const error = (await resolveClerkSource(options).catch((e: unknown) => e)) as CliError;

      expect(error).toBeInstanceOf(CliError);
      expect(error.message).toContain("won't export my-app (production) without asking");
      expect(error.message).toContain("--secret-key");
      expect(error.exitCode).toBe(EXIT_CODE.USAGE);
      expect(mockSearch).not.toHaveBeenCalled();
    },
  );

  test("agent mode still takes a named source", async () => {
    human = false;
    stubResolved(undefined, "sk_test_explicit");

    const source = await resolveClerkSource({ secretKey: "sk_test_explicit" });

    expect(source.secretKey).toBe("sk_test_explicit");
  });

  // Unlinked with no key, the resolver says "not linked" before "no key".
  test.each([
    ["-y", (): void => setAssumeYes(true), {}, ERROR_CODE.NOT_LINKED],
    ["--json", (): void => {}, { json: true }, ERROR_CODE.NOT_LINKED],
    ["--json, no key", (): void => {}, { json: true }, ERROR_CODE.NO_SECRET_KEY],
  ] as const)(
    "%s in an unlinked directory is a usage error naming the flags",
    async (_label, arrange, options, code) => {
      mockDescribeBapiTarget.mockRejectedValue(new CliError("No Clerk project linked.", { code }));
      arrange();

      await expect(resolveClerkSource(options)).rejects.toThrow(
        /has no source instance, and can't ask here/,
      );
      expect(mockResolveUsersInstanceContext).not.toHaveBeenCalled();
    },
  );

  // What the real resolver throws in an unlinked directory with no key. The
  // same flat list as the linked case, with no "create a new application" row.
  test("an unlinked directory offers every instance, flat, instead of failing", async () => {
    mockDescribeBapiTarget.mockRejectedValue(
      new CliError("No Clerk project linked to this directory.", { code: ERROR_CODE.NOT_LINKED }),
    );
    mockFetchApps.mockResolvedValue([
      {
        application_id: "app_1",
        name: "other-app",
        instances: [{ instance_id: "ins_1p", environment_type: "production" }],
      },
    ]);
    mockSearch.mockResolvedValue({ app: "app_1", instance: "ins_1p" });
    mockResolveUsersInstanceContext.mockResolvedValue({
      secretKey: "sk_test_picked",
      appLabel: "other-app",
      instanceLabel: "production",
    });

    const source = await resolveClerkSource({});

    expect(source).toEqual({ secretKey: "sk_test_picked", target: "other-app (production)" });
    const { source: listSource } = mockSearch.mock.calls[0]![0];
    expect(listSource("").map((choice: { name: string }) => choice.name)).toEqual([
      "other-app - Production instance (ins_1p)",
    ]);
    expect(mockResolveUsersInstanceContext).toHaveBeenCalledWith({
      app: "app_1",
      instance: "ins_1p",
    });
  });

  test("an unlinked directory with no login is a usage error naming the flags", async () => {
    mockDescribeBapiTarget.mockRejectedValue(
      new CliError("No Clerk project linked to this directory.", { code: ERROR_CODE.NOT_LINKED }),
    );
    mockFetchApps.mockRejectedValue(
      new CliError("Not authenticated. Run `clerk auth login`.", {
        code: ERROR_CODE.AUTH_REQUIRED,
      }),
    );

    const error = (await resolveClerkSource({}).catch((e: unknown) => e)) as CliError;

    expect(error.exitCode).toBe(EXIT_CODE.USAGE);
    expect(error.message).toContain("Listing your applications needs `clerk auth login`");
    expect(error.message).toContain("--secret-key");
    expect(mockConfirm).not.toHaveBeenCalled();
  });

  // Only "can't list" offers the resolved instance. A failure after picking
  // another one is that failure, not a reason to offer the destination.
  test("a failure after picking an instance goes through, not to the fallback", async () => {
    stubResolved("my-app (development)");
    mockFetchApps.mockResolvedValue([
      {
        application_id: "app_1",
        name: "other-app",
        instances: [{ instance_id: "ins_1p", environment_type: "production" }],
      },
    ]);
    mockSearch.mockResolvedValue({ app: "app_1", instance: "ins_1p" });
    const failure = new CliError("Could not fetch that instance's secret key.");
    mockResolveUsersInstanceContext.mockRejectedValue(failure);

    await expect(resolveClerkSource({})).rejects.toThrow(failure);
    expect(mockConfirm).not.toHaveBeenCalled();
  });

  test("names why it offers the resolved instance when applications can't be listed", async () => {
    stubResolved("this accountless application (secret key from .env)");
    mockFetchApps.mockRejectedValue(
      new CliError("Not authenticated. Run `clerk auth login`.", {
        code: ERROR_CODE.AUTH_REQUIRED,
      }),
    );
    mockConfirm.mockResolvedValue(true);

    await resolveClerkSource({});

    expect(mockConfirm.mock.calls[0]![0].message).toContain(
      "Listing your applications needs a login",
    );
  });

  test("an explicit --app that fails to resolve surfaces the error, not the picker", async () => {
    const failure = new CliError("No secret key found.", { code: ERROR_CODE.NO_SECRET_KEY });
    mockDescribeBapiTarget.mockRejectedValue(failure);

    await expect(resolveClerkSource({ app: "app_123" })).rejects.toThrow(failure);

    expect(mockResolveUsersInstanceContext).not.toHaveBeenCalled();
  });
});
