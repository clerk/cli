import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runAndroidDoctorChecks } from "./android.ts";
import type { DoctorContext } from "./types.ts";
import { createAndroidFixture, fakeNativeAPI, keystore } from "../init/android/test-helpers.ts";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

test("an inspection failure reports its cause and remedy", async () => {
  const root = await mkdtemp(join(tmpdir(), "clerk-doctor-android-"));
  roots.push(root);
  const ctx = { getProfile: async () => undefined } as unknown as DoctorContext;
  const [result] = await runAndroidDoctorChecks(ctx, { root });
  expect(result).toMatchObject({ name: "Android project", status: "fail" });
  expect(result?.message).toContain("none found");
  expect(result?.remedy).toContain("--android-module");
});

test("the engine's checks are reported with remedies, keeping local checks when Clerk fails", async () => {
  const root = await createAndroidFixture();
  roots.push(root);
  const ctx = {
    getProfile: async () => ({ profile: { appId: "app_test" } }),
  } as unknown as DoctorContext;
  const { api, state } = fakeNativeAPI();
  state.wrongApp = true;
  const results = await runAndroidDoctorChecks(ctx, { root }, { api, debugKeystore: keystore() });
  expect(results.map((result) => result.name)).toContain("Clerk initialization");
  expect(results.at(-1)).toMatchObject({ name: "Clerk native settings", status: "warn" });
  for (const result of results) if (result.status !== "pass") expect(result.remedy).toBeTruthy();
});
