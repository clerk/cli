import { join } from "node:path";
import { useFixture, runFixtureTest, runBrowserTest } from "./lib/fixture-test.ts";
import type { FixtureConfig } from "./lib/types.ts";

const fixtureDir = join(import.meta.dir, "fixtures/tanstack-start");

export const config = {
  description: "TanStack Start with TypeScript",
  scaffoldCmd: [
    "bunx",
    "@tanstack/cli@latest",
    "create",
    "myapp",
    "--target-dir",
    ".",
    "--no-install",
    "--no-git",
    "--no-toolchain",
    "--no-examples",
    "--force",
  ],
  clerkSdk: "@clerk/tanstack-react-start",
  buildCmd: ["vite", "build"],
  devCmd: ["vite", "dev"],
  pinned: false,
} satisfies FixtureConfig;

const getFixture = useFixture(fixtureDir, config);
runFixtureTest(getFixture, config);
runBrowserTest(getFixture, config);
