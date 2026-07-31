import { describe } from "bun:test";
import {
  createFixtureHarness,
  runFixtureTests,
  runFileExistsTest,
  runServerTests,
} from "./lib/fixture-test.ts";

describe("express", () => {
  const harness = createFixtureHarness("express");

  runFixtureTests(harness);
  runFileExistsTest(harness, ["types/globals.d.ts"]);
  // No browser test: the fixture has no UI. The server test proves the
  // middleware runs with the pulled keys on a live request instead.
  runServerTests(harness);
});
