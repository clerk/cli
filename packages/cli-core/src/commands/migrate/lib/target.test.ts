import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { useCaptureLog } from "../../../test/lib/stubs.ts";
import { describeTarget, fetchInstanceIdentity, printTarget } from "./target.ts";

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
