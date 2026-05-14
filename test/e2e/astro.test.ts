import { describe } from "bun:test";
import { createFixtureHarness, runFixtureTests, runBrowserTests } from "./lib/fixture-test.ts";

describe("Astro with Typescript", () => {
  const harness = createFixtureHarness("astro");

  describe("clerk init", () => {
    runFixtureTests(harness);
    runBrowserTests(harness);
  });
});
