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
});
