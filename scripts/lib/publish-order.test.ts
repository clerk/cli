import { describe, expect, test } from "bun:test";
import { publishDependenciesBeforePackage } from "./publish-order.ts";

describe("publishDependenciesBeforePackage", () => {
  test("publishes the dependent package only after every dependency is available", async () => {
    const events: string[] = [];
    const resolvers: Array<() => void> = [];

    const publish = publishDependenciesBeforePackage(
      [
        {
          publish: async () => {
            events.push("linux:publish");
          },
          waitUntilAvailable: async () => {
            events.push("linux:wait");
            await new Promise<void>((resolve) => resolvers.push(resolve));
            events.push("linux:available");
          },
        },
        {
          publish: async () => {
            events.push("darwin:publish");
          },
          waitUntilAvailable: async () => {
            events.push("darwin:wait");
            await new Promise<void>((resolve) => resolvers.push(resolve));
            events.push("darwin:available");
          },
        },
      ],
      {
        publish: async () => {
          events.push("clerk:publish");
        },
        waitUntilAvailable: undefined,
      },
    );

    await Promise.resolve();
    expect(events).toEqual(["linux:publish", "darwin:publish", "linux:wait", "darwin:wait"]);

    resolvers[0]!();
    await Promise.resolve();
    expect(events).not.toContain("clerk:publish");

    resolvers[1]!();
    await publish;
    expect(events).toEqual([
      "linux:publish",
      "darwin:publish",
      "linux:wait",
      "darwin:wait",
      "linux:available",
      "darwin:available",
      "clerk:publish",
    ]);
  });

  test("lets every dependency finish and skips the dependent when one fails", async () => {
    const events: string[] = [];
    let releaseDarwin!: () => void;

    const publish = publishDependenciesBeforePackage(
      [
        {
          publish: async () => {
            throw new Error("linux failed");
          },
          waitUntilAvailable: undefined,
        },
        {
          publish: async () => {
            await new Promise<void>((resolve) => (releaseDarwin = resolve));
            events.push("darwin:publish");
          },
          waitUntilAvailable: undefined,
        },
      ],
      {
        publish: async () => {
          events.push("clerk:publish");
        },
        waitUntilAvailable: undefined,
      },
    );

    let settled = false;
    const outcome = publish.then(
      () => "resolved",
      (error: Error) => error.message,
    );
    void outcome.then(() => (settled = true));
    await Bun.sleep(0);
    expect(settled).toBe(false);

    releaseDarwin();
    expect(await outcome).toBe("linux failed");
    expect(events).toEqual(["darwin:publish"]);
  });

  test("reports every failed dependency", async () => {
    const failing = (message: string) => ({
      publish: async () => {
        throw new Error(message);
      },
      waitUntilAvailable: undefined,
    });

    await expect(
      publishDependenciesBeforePackage([failing("linux failed"), failing("darwin failed")], {
        publish: async () => {},
        waitUntilAvailable: undefined,
      }),
    ).rejects.toThrow("2 dependency publishes failed:\n  - linux failed\n  - darwin failed");
  });
});
