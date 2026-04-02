import { join } from "node:path";
import { useFixture, runFixtureTest, runBrowserTest } from "./lib/fixture-test.ts";
import type { FixtureConfig } from "./lib/types.ts";

const fixtureDir = join(import.meta.dir, "fixtures/astro");

export const config = {
  description: "Astro with TypeScript",
  scaffoldCmd: [
    "bunx",
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
  pinned: false,
} satisfies FixtureConfig;

const getFixture = useFixture(fixtureDir, config);
runFixtureTest(getFixture, config);
runBrowserTest(getFixture, config);
