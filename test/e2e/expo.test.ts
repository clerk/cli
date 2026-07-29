import { describe } from "bun:test";
import { createFixtureHarness, runFixtureTests, runFileExistsTest } from "./lib/fixture-test.ts";

describe("expo", () => {
  const harness = createFixtureHarness("expo");

  // Build is `expo export --platform web`: Metro bundles the
  // ClerkProvider-wrapped layout (including @clerk/expo/token-cache and its
  // expo-secure-store dependency), so a broken scaffold fails here. No browser
  // test — the exported bundle is a native app shell, not a sign-in UI, and
  // native builds need Xcode/Gradle toolchains CI doesn't have.
  runFixtureTests(harness);
  runFileExistsTest(harness, ["src/app/_layout.tsx", "app/_layout.tsx"]);
});
