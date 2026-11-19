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

const unlinked = { getProfile: async () => undefined } as unknown as DoctorContext;

test("several application modules report the selection and the module remedy", async () => {
  const root = await createAndroidFixture();
  roots.push(root);
  await Bun.$`cp -R ${join(root, "app")} ${join(root, "tv")}`.quiet();
  const [result] = await runAndroidDoctorChecks(unlinked, { root });
  expect(result).toMatchObject({ name: "Android project", status: "fail" });
  expect(result?.message).toContain("could not be inspected");
  expect(result?.message).toContain("app, tv");
  expect(result?.remedy).toContain("--android-module");
});

test.each([
  [
    "no module that applies the application plugin",
    async (_root: string) => {},
    "No Android application module was found",
  ],
  [
    "an unused catalog entry below the baseline",
    async (root: string) => {
      await Bun.write(
        join(root, "gradle/libs.versions.toml"),
        '[libraries]\nclerk-api = { module = "com.clerk:clerk-android-api", version = "1.0.0" }\n',
      );
    },
    "below the 1.3.0 baseline",
  ],
])(
  "an unsupported layout (%s) reports its reason, not the module remedy",
  async (_, arrange, reason) => {
    const root = reason.startsWith("No Android")
      ? await mkdtemp(join(tmpdir(), "clerk-doctor-android-"))
      : await createAndroidFixture();
    roots.push(root);
    await arrange(root);
    const results = await runAndroidDoctorChecks(unlinked, { root });
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ name: "Android project", status: "fail" });
    expect(results[0]?.message).toContain(reason);
    // Doctor edits nothing, so init's "no files were changed" isn't part of its message.
    expect(results[0]?.message).not.toContain("No Android project files were changed");
    expect(results[0]?.remedy).not.toContain("--android-module");
    expect(results[0]?.remedy).toContain("clerk init");
  },
);

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
