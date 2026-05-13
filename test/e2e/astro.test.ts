import { join } from "node:path";
import { describe } from "bun:test";
import { createGetFixture, runFixtureTest, runBrowserTest } from "./lib/fixture-test.ts";
import type { FixtureConfig } from "./lib/types.ts";

const fixtureDir = join(import.meta.dir, "fixtures/astro");

export const config = {
  scaffoldCmd: [
    "npx",
    "--yes",
    "create-astro@latest",
    ".",
    "--template",
    "minimal",
    "--typescript",
    "strict",
    "--no-install",
    "--yes",
  ],
  clerkSdk: "@clerk/astro",
  buildCmd: ["astro", "build"],
  devCmd: ["astro", "dev"],
} satisfies FixtureConfig;

describe("Astro with Typescript", () => {
  const getFixture = createGetFixture(fixtureDir);

  describe("clerk init", () => {
    runFixtureTest(getFixture, config);
    runBrowserTest(getFixture, config);
  });
});
