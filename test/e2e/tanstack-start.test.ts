import { describe } from "bun:test";
import { createFixtureHarness, runFixtureTests, runBrowserTests } from "./lib/fixture-test.ts";

describe("TanStack Start with TypeScript", () => {
  const harness = createFixtureHarness("tanstack-start");

  describe("clerk init", () => {
    runFixtureTests(harness);
    runBrowserTests(harness);
  });
});
