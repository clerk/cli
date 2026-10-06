import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { EXIT_CODE, type CliError } from "../../../lib/errors.ts";
import { useCaptureLog } from "../../../test/lib/stubs.ts";
import {
  describeTarget,
  fetchInstanceIdentity,
  printTarget,
  resolveClerkTarget,
} from "./target.ts";

const captured = useCaptureLog();

describe("printTarget", () => {
  test.each([
    [
      "a linked app",
      {
        env: "production",
        appId: "app_1",
        appLabel: "My App",
        instanceId: "ins_1",
        keySource: "linked profile",
      },
      "Target: My App (app_1), production instance ins_1",
      "Key from: linked profile",
    ],
    [
      "a bare --secret-key",
      { env: "development", instanceId: "ins_2", keySource: "--secret-key" },
      "Target: development instance ins_2",
      "Key from: --secret-key",
    ],
    [
      "an exported CLERK_SECRET_KEY",
      { env: "development", instanceId: "ins_3", keySource: "CLERK_SECRET_KEY env var" },
      "Target: development instance ins_3",
      "Key from: CLERK_SECRET_KEY env var",
    ],
  ])("names %s", (_label, target, first, second) => {
    printTarget(target);
    const lines = Bun.stripANSI(captured.err).split("\n");
    expect(lines).toEqual([first, second]);
  });

  test("names an export's source platform", () => {
    printTarget({ platform: "auth0" });
    expect(captured.err).toBe("Source: auth0");
  });

  test("names the Clerk instance a Clerk export reads", () => {
    printTarget({ platform: "clerk", env: "production", instanceId: "ins_9" });
    expect(Bun.stripANSI(captured.err)).toBe("Source: Clerk, production instance ins_9");
  });
});

describe("describeTarget", () => {
  test("is one line for a list", () => {
    expect(describeTarget({ appLabel: "My App", env: "development", instanceId: "ins_1" })).toBe(
      "My App (development, ins_1)",
    );
    expect(describeTarget({ platform: "auth0" })).toBe("auth0");
  });
});

describe("fetchInstanceIdentity", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeAll(() => {
    originalFetch = globalThis.fetch;
  });

  afterAll(() => {
    globalThis.fetch = originalFetch;
  });

  test("reads the instance behind the key", async () => {
    globalThis.fetch = (async () =>
      Response.json({
        object: "instance",
        id: "ins_7",
        environment_type: "production",
      })) as unknown as typeof fetch;

    expect(await fetchInstanceIdentity("sk_live_x")).toEqual({
      instanceId: "ins_7",
      env: "production",
    });
  });

  test("retries a 429 rather than falling back", async () => {
    let calls = 0;
    globalThis.fetch = (async () =>
      ++calls === 1
        ? new Response("{}", { status: 429, headers: { "retry-after": "1" } })
        : Response.json({
            id: "ins_7",
            environment_type: "development",
          })) as unknown as typeof fetch;

    expect((await fetchInstanceIdentity("sk_test_x")).instanceId).toBe("ins_7");
    expect(calls).toBe(2);
  });

  // The same key always addresses the same instance, so a hash still tells two
  // instances apart when the API cannot say.
  test("falls back to a stable hash of the key when the instance cannot be read", async () => {
    globalThis.fetch = (async () =>
      new Response("nope", { status: 500 })) as unknown as typeof fetch;

    const first = await fetchInstanceIdentity("sk_test_a");
    expect(first.instanceId).toMatch(/^key_[0-9a-f]{16}$/);
    expect(first.env).toBe("development");
    expect(await fetchInstanceIdentity("sk_test_a")).toEqual(first);
    expect((await fetchInstanceIdentity("sk_test_b")).instanceId).not.toBe(first.instanceId);
  });
});

describe("resolveClerkTarget --instance", () => {
  let originalFetch: typeof globalThis.fetch;
  let originalKey: string | undefined;

  beforeAll(() => {
    originalFetch = globalThis.fetch;
    originalKey = process.env.CLERK_SECRET_KEY;
    globalThis.fetch = (async () =>
      Response.json({ id: "ins_prod", environment_type: "production" })) as unknown as typeof fetch;
  });

  afterAll(() => {
    globalThis.fetch = originalFetch;
    if (originalKey === undefined) delete process.env.CLERK_SECRET_KEY;
    else process.env.CLERK_SECRET_KEY = originalKey;
  });

  // An exported production key would otherwise win over `--instance dev`
  // without a word, and the import would write to production.
  test.each([
    ["an exported key", { instance: "dev" }, "sk_live_x"],
    ["--secret-key", { instance: "dev", secretKey: "sk_live_x" }, undefined],
    ["--secret-key, with a literal ID", { instance: "ins_dev", secretKey: "sk_live_x" }, undefined],
  ])("refuses %s that addresses another instance", async (_label, options, envKey) => {
    if (envKey) process.env.CLERK_SECRET_KEY = envKey;
    else delete process.env.CLERK_SECRET_KEY;

    const error = (await resolveClerkTarget(options).catch((e: unknown) => e)) as CliError;
    expect(error.exitCode).toBe(EXIT_CODE.USAGE);
    expect(error.message).toContain("does not match the key");
  });

  test.each([["prod"], ["production"], ["ins_prod"]])("accepts --instance %s", async (instance) => {
    delete process.env.CLERK_SECRET_KEY;
    const { target } = await resolveClerkTarget({ instance, secretKey: "sk_live_x" });
    expect(target.instanceId).toBe("ins_prod");
  });
});
