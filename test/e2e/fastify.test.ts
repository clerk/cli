import { describe } from "bun:test";
import { createFixtureHarness, runFixtureTests, runServerTests } from "./lib/fixture-test.ts";

describe("fastify", () => {
  const harness = createFixtureHarness("fastify");

  runFixtureTests(harness);
  // No browser test: the fixture has no UI. The server test proves the
  // plugin runs with the pulled keys on a live request instead.
  runServerTests(harness);
});
