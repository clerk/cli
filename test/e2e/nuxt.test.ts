import { describe } from "bun:test";
import { createFixtureHarness, runFixtureTests, runBrowserTests } from "./lib/fixture-test.ts";

describe("Nuxt with TypeScript", () => {
  const harness = createFixtureHarness("nuxt");

  describe("clerk init", () => {
    runFixtureTests(harness);
    runBrowserTests(harness);
  });
});
