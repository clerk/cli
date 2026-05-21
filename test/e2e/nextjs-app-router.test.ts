import { describe } from "bun:test";
import {
  createFixtureHarness,
  runFixtureTests,
  runFileExistsTest,
  runBrowserTests,
} from "./lib/fixture-test.ts";

describe("Next.js App Router with TypeScript", () => {
  const harness = createFixtureHarness("nextjs-app-router");

  describe("clerk init", () => {
    runFixtureTests(harness);
    runFileExistsTest(harness, ["proxy.ts"]);
    runBrowserTests(harness);
  });
});
