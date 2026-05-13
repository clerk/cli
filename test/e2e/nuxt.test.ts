import { join } from "node:path";
import { describe } from "bun:test";
import { createGetFixture, runFixtureTest, runBrowserTest } from "./lib/fixture-test.ts";
import type { FixtureConfig } from "./lib/types.ts";

const fixtureDir = join(import.meta.dir, "fixtures/nuxt");

export const config = {
  scaffoldCmd: [
    "npx",
    "--yes",
    "nuxi@latest",
    "init",
    ".",
    "--template",
    "minimal",
    "--no-install",
    "--packageManager",
    "npm",
    "--force",
  ],
  clerkSdk: "@clerk/nuxt",
  buildCmd: ["nuxt", "build"],
  devCmd: ["nuxt", "dev"],
} satisfies FixtureConfig;

describe("Nuxt with TypeScript", () => {
  const getFixture = createGetFixture(fixtureDir);

  describe("clerk init", () => {
    runFixtureTest(getFixture, config);
    runBrowserTest(getFixture, config);
  });
});
