import { join } from "node:path";
import { describe } from "bun:test";
import { createGetFixture, runFixtureTest, runBrowserTest } from "./lib/fixture-test.ts";
import type { FixtureConfig } from "./lib/types.ts";

const fixtureDir = join(import.meta.dir, "fixtures/react-router");

export const config = {
  scaffoldCmd: [
    "npx",
    "--yes",
    "create-react-router@latest",
    ".",
    "--package-manager",
    "npm",
    "--no-install",
    "--yes",
  ],
  clerkSdk: "@clerk/react-router",
  buildCmd: ["react-router", "build"],
  devCmd: ["react-router", "dev"],
} satisfies FixtureConfig;

describe("React Router with TypeScript", () => {
  const getFixture = createGetFixture(fixtureDir);

  describe("clerk init", () => {
    runFixtureTest(getFixture, config);
    runBrowserTest(getFixture, config);
  });
});
