import { describe, expect, test } from "bun:test";
import { transformerKeys } from "../transformers/registry.ts";
import { exportPlatformKeys, exportPlatforms, getExportPlatform } from "./registry.ts";

describe("export registry", () => {
  test("registers every source platform", () => {
    expect(exportPlatformKeys()).toEqual([
      "clerk",
      "auth0",
      "supabase",
      "authjs",
      "firebase",
      "betterauth",
    ]);
  });

  test.each([...exportPlatforms])("$key carries a label and description", (entry) => {
    expect(entry.label.length).toBeGreaterThan(0);
    expect(entry.description.length).toBeGreaterThan(0);
  });

  // The picker, the docs and the "what next" line all read this, so a typo
  // would send someone to a transformer that does not exist.
  test.each([...exportPlatforms])("$key names a real transformer", (entry) => {
    expect(transformerKeys()).toContain(entry.transformerKey);
  });

  test.each([...exportPlatforms])("$key has something to run", (entry) => {
    expect(typeof entry.run).toBe("function");
  });

  test("looks a platform up by key", () => {
    expect(getExportPlatform("auth0")?.label).toBe("Auth0");
  });

  test("returns nothing for a platform that is not registered", () => {
    expect(getExportPlatform("okta")).toBeUndefined();
  });
});
