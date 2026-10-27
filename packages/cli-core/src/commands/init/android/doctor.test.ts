import { afterEach, describe, expect, test } from "bun:test";
import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { CLERK_ANDROID_MINIMUM_VERSION } from "./sdk.ts";
import { doctor } from "./doctor.ts";
import { applySetup, prepareSetup } from "./workflow.ts";
import {
  createAndroidFixture,
  DEBUG_FINGERPRINT,
  RELEASE_FINGERPRINT,
  fakeNativeAPI,
  keystore,
} from "./test-helpers.ts";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function fixture(options: Parameters<typeof createAndroidFixture>[0] = {}) {
  const root = await createAndroidFixture(options);
  roots.push(root);
  const { api, state } = fakeNativeAPI();
  return { root, state, dependencies: { api, debugKeystore: keystore() } };
}
const options = (root: string, remote = true) => ({
  root,
  sdk: "core" as const,
  minimumVersion: CLERK_ANDROID_MINIMUM_VERSION,
  inspectOnly: true,
  remote: remote ? { applicationId: "app_test" } : undefined,
});
const status = (report: Awaited<ReturnType<typeof doctor>>) =>
  Object.fromEntries(report.checks.map((check) => [check.name, check.status]));

describe("Android doctor", () => {
  test("an unconfigured project fails the local checks with remedies", async () => {
    const f = await fixture({ minSdk: 21 });
    const report = await doctor(options(f.root), f.dependencies);
    expect(status(report)).toEqual({
      "Android module coverage": "pass",
      "SDK dependency": "warn",
      "SDK version requirement": "warn",
      "Kotlin compiler": "pass",
      minSdk: "fail",
      Manifest: "fail",
      "Clerk initialization": "fail",
      "Development publishable key": "warn",
      "Native API": "fail",
      "Native registration": "fail",
    });
    expect(report.status).toBe("failed");
    for (const check of report.checks)
      if (check.status !== "pass") expect(check.remedy).toBeTruthy();
  });

  test("a project clerk init set up passes, including this machine's fingerprint", async () => {
    const f = await fixture();
    await applySetup(
      await prepareSetup({ ...options(f.root), inspectOnly: false }, f.dependencies),
      f.dependencies,
    );
    const report = await doctor(options(f.root), f.dependencies);
    expect(Object.values(status(report)).every((value) => value === "pass")).toBe(true);
    expect(
      report.checks.find((check) => check.name === "Debug signing fingerprint")?.message,
    ).toContain(DEBUG_FINGERPRINT);
    expect(report.status).toBe("needs-verification");
    expect(JSON.stringify(report)).not.toContain("pk_test_");
  });

  test("a registration without this machine's fingerprint is a failing finding", async () => {
    const f = await fixture();
    f.state.enabled = true;
    f.state.registrations.push({
      object: "android_application",
      id: "androidapp_1",
      namespace: "android_app",
      package_name: "com.example.myapp",
      fingerprints: [RELEASE_FINGERPRINT],
    });
    const report = await doctor(options(f.root), f.dependencies);
    const registration = report.checks.find((check) => check.name === "Native registration")!;
    expect(registration.status).toBe("fail");
    expect(registration.message).toContain(DEBUG_FINGERPRINT);
    expect(registration.remedy).toContain("Native Applications page");
  });

  test("an unreadable minSdk is a warning, and the other checks still run", async () => {
    const f = await fixture();
    const path = join(f.root, "app/build.gradle.kts");
    await writeFile(
      path,
      (await Bun.file(path).text()).replace(
        "minSdk = 24",
        "minSdk = libs.versions.minSdk.get().toInt()",
      ),
    );
    const report = await doctor(options(f.root), f.dependencies);
    expect(status(report).minSdk).toBe("warn");
    expect(status(report)["Native registration"]).toBe("fail");
  });

  test("a literal key is compared with the linked instance's", async () => {
    const f = await fixture({ application: "custom-initialized", internetPermission: true });
    const report = await doctor(options(f.root), f.dependencies);
    expect(status(report)["Development publishable key"]).toBe("pass");
    const path = join(f.root, "app/src/main/java/com/example/myapp/CustomApp.kt");
    await writeFile(path, (await Bun.file(path).text()).replace(/pk_test_[^"]+/, "pk_test_other"));
    expect(
      status(await doctor(options(f.root), f.dependencies))["Development publishable key"],
    ).toBe("fail");
  });

  test("without a linked application the remote checks become one warning", async () => {
    const f = await fixture();
    const report = await doctor(options(f.root, false), {
      api: f.dependencies.api,
      debugKeystore: keystore("no-keystore"),
    });
    expect(status(report)["Native registration"]).toBe("warn");
    expect(report.identity.fingerprints).toEqual([]);
  });

  test("never blocks on what setup would refuse to edit", async () => {
    const f = await fixture({ kotlin: "2.2.21" });
    const report = await doctor(options(f.root), f.dependencies);
    expect(status(report)["Kotlin compiler"]).toBe("fail");
  });
});
