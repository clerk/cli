import { join } from "node:path";
import { useFixture, runFixtureTest, runBrowserTest } from "./lib/fixture-test.ts";
import type { FixtureConfig } from "./lib/types.ts";

const fixtureDir = join(import.meta.dir, "fixtures/react");

export const config = {
  description: "React with Vite and TypeScript",
  scaffoldCmd: ["bunx", "create-vite@latest", ".", "--template", "react-ts"],
  clerkSdk: "@clerk/react",
  buildCmd: ["vite", "build"],
  devCmd: ["vite"],
  pinned: false,
} satisfies FixtureConfig;

const getFixture = useFixture(fixtureDir, config);
runFixtureTest(getFixture, config);
runBrowserTest(getFixture, config);
