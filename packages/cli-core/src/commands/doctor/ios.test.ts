import { afterEach, expect, spyOn, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as coordinator from "../init/ios/coordinator.ts";
import { runIOSDoctorChecks } from "./ios.ts";
import type { DoctorContext } from "./types.ts";

const ctx = { getProfile: async () => undefined } as unknown as DoctorContext;
const xcode = spyOn(coordinator, "canSetUpXcode");
afterEach(() => xcode.mockReset());

test("without Xcode, the Xcode checks become one warning", async () => {
  xcode.mockReturnValue(false);
  expect(await runIOSDoctorChecks(ctx, {})).toEqual([
    expect.objectContaining({ name: "Xcode project", status: "warn" }),
  ]);
});

test("an inspection failure reports its cause", async () => {
  xcode.mockReturnValue(true);
  const root = await mkdtemp(join(tmpdir(), "clerk-doctor-ios-"));
  try {
    const [result] = await runIOSDoctorChecks(ctx, { root });
    expect(result).toMatchObject({ name: "Xcode project", status: "fail" });
    expect(result?.message).toContain("none found");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
