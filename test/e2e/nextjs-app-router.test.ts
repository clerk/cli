import { join } from "node:path";
import { describe } from "bun:test";
import {
  createGetFixture,
  runFixtureTest,
  runFileExistsTest,
  runBrowserTest,
} from "./lib/fixture-test.ts";
import type { FixtureConfig } from "./lib/types.ts";

const fixtureDir = join(import.meta.dir, "fixtures/nextjs-app-router");

export const config = {
  scaffoldCmd: [
    "npx",
    "--yes",
    "create-next-app@latest",
    ".",
    "--ts",
    "--app",
    "--no-tailwind",
    "--no-eslint",
    "--use-npm",
    "--skip-install",
    "--yes",
  ],
  clerkSdk: "@clerk/nextjs",
  buildCmd: ["next", "build"],
  devCmd: ["next", "dev"],
} satisfies FixtureConfig;

describe("Next.js App Router with TypeScript", () => {
  const getFixture = createGetFixture(fixtureDir);

  describe("clerk init", () => {
    runFixtureTest(getFixture, config);
    runFileExistsTest(getFixture, config, ["proxy.ts"]);
    runBrowserTest(getFixture, config);
  });
});
