import { describe } from "bun:test";
import { createFixtureHarness, runFixtureTests, runBrowserTests } from "./lib/fixture-test.ts";

describe("React Router with TypeScript", () => {
  const harness = createFixtureHarness("react-router");

  describe("clerk init", () => {
    runFixtureTests(harness);
    runBrowserTests(harness);
  });
});
