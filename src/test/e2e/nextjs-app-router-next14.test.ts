import { join } from "node:path";
import {
  useFixture,
  runFixtureTest,
  runFileExistsTest,
  runBrowserTest,
} from "./lib/fixture-test.ts";
import type { FixtureConfig } from "./lib/types.ts";

const fixtureDir = join(import.meta.dir, "fixtures/nextjs-app-router-next14");

export const config = {
  description: "Next.js 14 App Router - middleware.ts basename (not proxy.ts)",
  scaffoldCmd: [
    "env",
    "CI=1",
    "bunx",
    "create-next-app@14",
    ".",
    "--ts",
    "--app",
    "--no-tailwind",
    "--no-eslint",
  ],
  clerkSdk: "@clerk/nextjs",
  buildCmd: ["next", "build"],
  devCmd: ["next", "dev"],
  pinned: true,
  notes:
    "Next.js <16 uses middleware.ts; >=16 uses proxy.ts. This fixture tests the version-aware middleware basename logic in src/commands/init/context.ts.",
} satisfies FixtureConfig;

const getFixture = useFixture(fixtureDir, config);
runFixtureTest(getFixture, config);
runFileExistsTest(getFixture, config, ["middleware.ts"]);
runBrowserTest(getFixture, config);
