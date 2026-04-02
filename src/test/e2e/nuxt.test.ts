import { join } from "node:path";
import { useFixture, runFixtureTest, runBrowserTest } from "./lib/fixture-test.ts";
import type { FixtureConfig } from "./lib/types.ts";

const fixtureDir = join(import.meta.dir, "fixtures/nuxt");

export const config = {
  description: "Nuxt with TypeScript",
  scaffoldCmd: [
    "bunx",
    "nuxi@latest",
    "init",
    ".",
    "--template",
    "minimal",
    "--no-install",
    "--force",
  ],
  clerkSdk: "@clerk/nuxt",
  buildCmd: ["nuxt", "build"],
  devCmd: ["nuxt", "dev"],
  pinned: false,
} satisfies FixtureConfig;

const getFixture = useFixture(fixtureDir, config);
runFixtureTest(getFixture, config);
runBrowserTest(getFixture, config);
