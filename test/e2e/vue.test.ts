import { describe } from "bun:test";
import { createFixtureHarness, runFixtureTests, runBrowserTests } from "./lib/fixture-test.ts";

describe("Vue with Vite and TypeScript", () => {
  const harness = createFixtureHarness("vue");

  describe("clerk init", () => {
    runFixtureTests(harness);
    runBrowserTests(harness);
  });
});
