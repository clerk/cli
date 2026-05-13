import { join } from "node:path";
import { describe } from "bun:test";
import { createGetFixture, runFixtureTest, runBrowserTest } from "./lib/fixture-test.ts";
import type { FixtureConfig } from "./lib/types.ts";

const fixtureDir = join(import.meta.dir, "fixtures/tanstack-start");

export const config = {
  scaffoldCmd: [
    "npx",
    "--yes",
    "@tanstack/cli@latest",
    "create",
    "myapp",
    "--target-dir",
    ".",
    "--no-install",
    "--package-manager",
    "npm",
    "--no-git",
    "--no-toolchain",
    "--no-examples",
    "--force",
  ],
  clerkSdk: "@clerk/tanstack-react-start",
  buildCmd: ["vite", "build"],
  devCmd: ["vite", "dev"],
  packageJsonOverrides: {
    devDependencies: {
      // TanStack Start's current scaffold omits this peer dependency even
      // though the Vite plugin imports it during config evaluation.
      "@rsbuild/core": "^2.0.0",
    },
  },
} satisfies FixtureConfig;

describe("TanStack Start with TypeScript", () => {
  const getFixture = createGetFixture(fixtureDir);

  describe("clerk init", () => {
    runFixtureTest(getFixture, config);
    runBrowserTest(getFixture, config);
  });
});
