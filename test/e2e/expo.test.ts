import { describe, beforeAll } from "bun:test";
import { join } from "node:path";
import { createFixtureHarness, runFixtureTests, runFileExistsTest } from "./lib/fixture-test.ts";

describe("expo", () => {
  const harness = createFixtureHarness("expo");

  // `expo start` generates expo-env.d.ts, whose expo/types reference declares
  // the template's CSS-module imports. No headless command emits it (`expo
  // export` and `expo customize` don't), so recreate the one-line file the dev
  // server would have written — without it the template itself fails tsc.
  // Runs after the harness's own beforeAll (hooks run in registration order).
  beforeAll(async () => {
    const { fixture } = harness();
    await Bun.write(
      join(fixture.projectDir, "expo-env.d.ts"),
      '/// <reference types="expo/types" />\n',
    );
  });

  // Build is `expo export --platform web`: Metro bundles the
  // ClerkProvider-wrapped layout (including @clerk/expo/token-cache and its
  // expo-secure-store dependency), so a broken scaffold fails here. No browser
  // test — the exported bundle is a native app shell, not a sign-in UI, and
  // native builds need Xcode/Gradle toolchains CI doesn't have.
  runFixtureTests(harness);
  runFileExistsTest(harness, ["src/app/_layout.tsx", "app/_layout.tsx"]);
});
