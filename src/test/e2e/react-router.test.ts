import { join } from "node:path";
import { useFixture, runFixtureTest, runBrowserTest } from "./lib/fixture-test.ts";
import type { FixtureConfig } from "./lib/types.ts";

const fixtureDir = join(import.meta.dir, "fixtures/react-router");

export const config = {
  description: "React Router with TypeScript",
  scaffoldCmd: ["bunx", "create-react-router@latest", ".", "--yes"],
  clerkSdk: "@clerk/react-router",
  buildCmd: ["react-router", "build"],
  devCmd: ["react-router", "dev"],
  pinned: false,
} satisfies FixtureConfig;

const getFixture = useFixture(fixtureDir, config);
runFixtureTest(getFixture, config);
runBrowserTest(getFixture, config);
