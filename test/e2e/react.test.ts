import { join } from "node:path";
import { describe } from "bun:test";
import { createGetFixture, runFixtureTest, runBrowserTest } from "./lib/fixture-test.ts";
import type { FixtureConfig } from "./lib/types.ts";

const fixtureDir = join(import.meta.dir, "fixtures/react");

export const config = {
  scaffoldCmd: ["npx", "--yes", "create-vite@latest", ".", "--template", "react-ts"],
  clerkSdk: "@clerk/react",
  buildCmd: ["vite", "build"],
  devCmd: ["vite"],
} satisfies FixtureConfig;

describe("React with Vite and TypeScript", () => {
  const getFixture = createGetFixture(fixtureDir);

  describe("clerk init", () => {
    runFixtureTest(getFixture, config);
    runBrowserTest(getFixture, config);
  });
});
