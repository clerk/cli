import { join } from "node:path";
import {
  useFixture,
  runFixtureTest,
  runFileExistsTest,
  runBrowserTest,
} from "./lib/fixture-test.ts";
import type { FixtureConfig } from "./lib/types.ts";

const fixtureDir = join(import.meta.dir, "fixtures/nextjs-app-router");

export const config = {
  description: "Next.js App Router with TypeScript",
  scaffoldCmd: [
    "bunx",
    "create-next-app@latest",
    ".",
    "--ts",
    "--app",
    "--no-tailwind",
    "--no-eslint",
    "--yes",
  ],
  clerkSdk: "@clerk/nextjs",
  buildCmd: ["next", "build"],
  devCmd: ["next", "dev"],
  pinned: false,
} satisfies FixtureConfig;

const getFixture = useFixture(fixtureDir, config);
runFixtureTest(getFixture, config);
runFileExistsTest(getFixture, config, ["proxy.ts"]);
runBrowserTest(getFixture, config);
