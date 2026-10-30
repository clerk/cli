import { afterAll, afterEach, describe, expect, spyOn, test } from "bun:test";
import * as telemetry from "../../lib/telemetry.ts";
import { exportPlatformKeys } from "./export/registry.ts";
import { sourceKeys } from "./sources/registry.ts";
import { recordMigrateSource } from "./telemetry.ts";

describe("recordMigrateSource", () => {
  const setSource = spyOn(telemetry, "setTelemetryMigrateSource");
  afterEach(() => setSource.mockClear());
  afterAll(() => setSource.mockRestore());

  // Read from the registries, so a new built-in reports itself, not `custom`.
  test.each([...new Set([...sourceKeys(), ...exportPlatformKeys()])])(
    "reports the built-in %s by name",
    (key) => {
      recordMigrateSource(key);
      expect(setSource).toHaveBeenCalledWith(key);
    },
  );

  test("reports a source someone wrote as custom, whatever its key", () => {
    recordMigrateSource("auth0", { custom: true });
    expect(setSource).toHaveBeenCalledWith("custom");
  });

  test("reports a key this CLI doesn't ship as custom", () => {
    recordMigrateSource("okta");
    expect(setSource).toHaveBeenCalledWith("custom");
  });
});
