import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { setCurrentEnv } from "../../lib/environment.ts";
import { stubFetch } from "../../test/lib/stubs.ts";
import { describeKeylessInstance, findKeylessClaimUrl } from "./keyless-claim.ts";

describe("findKeylessClaimUrl", () => {
  let projectDir: string;
  const originalFetch = globalThis.fetch;

  beforeEach(async () => {
    projectDir = await mkdtemp(join(tmpdir(), "clerk-open-keyless-"));
    setCurrentEnv("production");
  });

  afterEach(async () => {
    globalThis.fetch = originalFetch;
    await rm(projectDir, { recursive: true, force: true });
  });

  test("returns undefined when neither file exists", async () => {
    expect(await findKeylessClaimUrl(projectDir)).toBeUndefined();
  });

  test("reads the full claimUrl an SDK wrote for itself", async () => {
    await mkdir(join(projectDir, ".clerk", ".tmp"), { recursive: true });
    await writeFile(
      join(projectDir, ".clerk", ".tmp", "keyless.json"),
      JSON.stringify({ claimUrl: "https://dashboard.clerk.com/apps/claim?token=sdk-token" }),
    );

    expect(await findKeylessClaimUrl(projectDir)).toEqual({
      url: "https://dashboard.clerk.com/apps/claim?token=sdk-token",
      source: ".clerk/.tmp/keyless.json",
    });
  });

  test("rebuilds the URL from the CLI's own breadcrumb token", async () => {
    await mkdir(join(projectDir, ".clerk"), { recursive: true });
    await writeFile(
      join(projectDir, ".clerk", "keyless.json"),
      JSON.stringify({ claimToken: "cli-token", createdAt: new Date().toISOString() }),
    );

    expect(await findKeylessClaimUrl(projectDir)).toEqual({
      url: "https://dashboard.clerk.com/apps/claim?token=cli-token",
      source: ".clerk/keyless.json",
    });
  });

  test("prefers the SDK's own claimUrl over the CLI breadcrumb", async () => {
    await mkdir(join(projectDir, ".clerk", ".tmp"), { recursive: true });
    await writeFile(
      join(projectDir, ".clerk", ".tmp", "keyless.json"),
      JSON.stringify({ claimUrl: "https://dashboard.clerk.com/apps/claim?token=sdk-token" }),
    );
    await writeFile(
      join(projectDir, ".clerk", "keyless.json"),
      JSON.stringify({ claimToken: "cli-token", createdAt: new Date().toISOString() }),
    );

    const destination = await findKeylessClaimUrl(projectDir);
    expect(destination?.source).toBe(".clerk/.tmp/keyless.json");
  });

  test("falls back to the breadcrumb when the SDK file has no claimUrl", async () => {
    await mkdir(join(projectDir, ".clerk", ".tmp"), { recursive: true });
    await writeFile(
      join(projectDir, ".clerk", ".tmp", "keyless.json"),
      JSON.stringify({ secretKey: "sk_test_x" }),
    );
    await mkdir(join(projectDir, ".clerk"), { recursive: true });
    await writeFile(
      join(projectDir, ".clerk", "keyless.json"),
      JSON.stringify({ claimToken: "cli-token", createdAt: new Date().toISOString() }),
    );

    const destination = await findKeylessClaimUrl(projectDir);
    expect(destination?.source).toBe(".clerk/keyless.json");
  });

  test("ignores a malformed SDK keyless file and falls back to the breadcrumb", async () => {
    await mkdir(join(projectDir, ".clerk", ".tmp"), { recursive: true });
    await writeFile(join(projectDir, ".clerk", ".tmp", "keyless.json"), "{ not json");
    await writeFile(
      join(projectDir, ".clerk", "keyless.json"),
      JSON.stringify({ claimToken: "cli-token", createdAt: new Date().toISOString() }),
    );

    expect(await findKeylessClaimUrl(projectDir)).toEqual({
      url: "https://dashboard.clerk.com/apps/claim?token=cli-token",
      source: ".clerk/keyless.json",
    });
  });
});

describe("describeKeylessInstance", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    setCurrentEnv("production");
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test("returns instance id and environment type on success", async () => {
    stubFetch(async () =>
      Response.json({ id: "ins_abc", object: "instance", environment_type: "development" }),
    );

    expect(await describeKeylessInstance("sk_test_x")).toEqual({
      instanceId: "ins_abc",
      environmentType: "development",
    });
  });

  test("returns nulls instead of throwing when BAPI rejects the key", async () => {
    stubFetch(
      async () =>
        new Response(JSON.stringify({ errors: [{ message: "unauthorized" }] }), {
          status: 401,
        }),
    );

    expect(await describeKeylessInstance("sk_test_bad")).toEqual({
      instanceId: null,
      environmentType: null,
    });
  });

  test("returns nulls instead of throwing on a network failure", async () => {
    stubFetch(async () => {
      throw new Error("network down");
    });

    expect(await describeKeylessInstance("sk_test_x")).toEqual({
      instanceId: null,
      environmentType: null,
    });
  });
});
