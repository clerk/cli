import { describe, expect, test } from "bun:test";
import { waitUntilPublished } from "./npm.ts";

describe("waitUntilPublished", () => {
  test("retries until npm reports the package version is published", async () => {
    const attempts: string[] = [];

    await waitUntilPublished("@clerk/cli-linux-x64", "1.2.3-canary.0", {
      intervalMs: 0,
      timeoutMs: 1_000,
      isPublished: async (name, version) => {
        attempts.push(`${name}@${version}`);
        return attempts.length === 3;
      },
    });

    expect(attempts).toEqual([
      "@clerk/cli-linux-x64@1.2.3-canary.0",
      "@clerk/cli-linux-x64@1.2.3-canary.0",
      "@clerk/cli-linux-x64@1.2.3-canary.0",
    ]);
  });
});
