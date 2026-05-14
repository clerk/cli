import { describe } from "bun:test";
import {
  createFixtureHarness,
  runFixtureTests,
  runFileExistsTest,
  runBrowserTests,
} from "./lib/fixture-test.ts";

describe("Next.js 14 App Router - middleware.ts basename (not proxy.ts)", () => {
  const harness = createFixtureHarness("nextjs-app-router-next14");

  describe("clerk init", () => {
    runFixtureTests(harness);
    runFileExistsTest(harness, ["middleware.ts"]);
    runBrowserTests(harness);
  });
});
