import { test, expect } from "bun:test";
import { browser } from "./browser.ts";

test("browser.open returns an OpenResult shape", async () => {
  // We can't actually launch a browser in tests, so this only verifies
  // the function exists, accepts a URL, and returns a Promise resolving
  // to an object with an `ok` boolean. Real browser launching is tested
  // by integration/e2e suites.
  const result = await browser.open("about:blank");
  expect(typeof result.ok).toBe("boolean");
});
