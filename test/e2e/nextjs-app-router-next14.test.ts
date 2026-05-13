import { join } from "node:path";
import { describe } from "bun:test";
import {
  createGetFixture,
  runFixtureTest,
  runFileExistsTest,
  runBrowserTest,
} from "./lib/fixture-test.ts";
import type { FixtureConfig } from "./lib/types.ts";

const fixtureDir = join(import.meta.dir, "fixtures/nextjs-app-router-next14");

export const config = {
  scaffoldCmd: [
    "env",
    "CI=1",
    "npx",
    "--yes",
    "create-next-app@14",
    ".",
    "--ts",
    "--app",
    "--no-tailwind",
    "--no-eslint",
    "--use-npm",
  ],
  clerkSdk: "@clerk/nextjs",
  buildCmd: ["next", "build"],
  devCmd: ["next", "dev"],
  pinnedDependencyRanges: {
    next: "^14",
  },
  notes:
    "Next.js <16 uses middleware.ts; >=16 uses proxy.ts. This fixture tests the version-aware middleware basename logic in src/commands/init/context.ts.",
} satisfies FixtureConfig;

describe("Next.js 14 App Router - middleware.ts basename (not proxy.ts)", () => {
  const getFixture = createGetFixture(fixtureDir);

  describe("clerk init", () => {
    runFixtureTest(getFixture, config);
    runFileExistsTest(getFixture, config, ["middleware.ts"]);
    runBrowserTest(getFixture, config);
  });
});
