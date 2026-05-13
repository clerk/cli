import { join } from "node:path";
import { describe } from "bun:test";
import { createGetFixture, runFixtureTest, runBrowserTest } from "./lib/fixture-test.ts";
import type { FixtureConfig } from "./lib/types.ts";

const fixtureDir = join(import.meta.dir, "fixtures/vue");

export const config = {
  scaffoldCmd: ["npx", "--yes", "create-vite@latest", ".", "--template", "vue-ts"],
  clerkSdk: "@clerk/vue",
  buildCmd: ["vite", "build"],
  devCmd: ["vite"],
} satisfies FixtureConfig;

describe("Vue with Vite and TypeScript", () => {
  const getFixture = createGetFixture(fixtureDir);

  describe("clerk init", () => {
    runFixtureTest(getFixture, config);
    runBrowserTest(getFixture, config);
  });
});
