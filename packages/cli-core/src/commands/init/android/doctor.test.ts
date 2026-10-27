import { afterEach, describe, expect, test } from "bun:test";
import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { CLERK_ANDROID_MINIMUM_VERSION } from "./sdk.ts";
import { doctor } from "./doctor.ts";
import { applySetup, prepareSetup } from "./workflow.ts";
import {
  createAndroidFixture,
  DEBUG_FINGERPRINT,
  DEBUG_SHA1,
  FAKE_GOOGLE_CLIENT_ID,
  FAKE_GOOGLE_CLIENT_SECRET,
  RELEASE_FINGERPRINT,
  fakeGoogleAPI,
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
  return {
    root,
    state,
    dependencies: {
      api,
      googleAPI: fakeGoogleAPI({ enabled: false }).api,
      debugKeystore: keystore(),
    },
  };
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
      "Google connection": "warn",
      "Google Web client ID": "warn",
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
    expect(
      report.checks
        .filter((check) => !check.name.startsWith("Google"))
        .map((check) => check.status),
    ).toEqual(expect.arrayContaining(["pass"]));
    expect(
      report.checks
        .filter((check) => !check.name.startsWith("Google"))
        .every((check) => check.status === "pass"),
    ).toBe(true);
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

describe("Android doctor: Sign in with Google", () => {
  test("reports Google off as warnings, with the remedy", async () => {
    const f = await fixture();
    const google = fakeGoogleAPI({ enabled: false });
    const report = await doctor(options(f.root), { ...f.dependencies, googleAPI: google.api });
    expect(status(report)["Google connection"]).toBe("warn");
    expect(status(report)["Google Web client ID"]).toBe("warn");
    expect(report.checks.find((check) => check.name === "Google connection")?.remedy).toContain(
      "--sign-in-with-google",
    );
    expect(status(report)["Google Cloud Android client"]).toBeUndefined();
  });

  test("Google on without a Web client fails that check", async () => {
    const f = await fixture();
    const google = fakeGoogleAPI({ enabled: true });
    const report = await doctor(options(f.root), { ...f.dependencies, googleAPI: google.api });
    expect(status(report)["Google connection"]).toBe("pass");
    expect(status(report)["Google Web client ID"]).toBe("fail");
    expect(status(report)["Google Cloud Android client"]).toBe("warn");
    expect(
      report.checks.find((check) => check.name === "Google Cloud Android client")?.message,
    ).toContain(DEBUG_SHA1);
  });

  test("a configured connection passes, with the Android client left as a note", async () => {
    const f = await fixture();
    const google = fakeGoogleAPI({
      enabled: true,
      client_id: FAKE_GOOGLE_CLIENT_ID,
      client_secret: FAKE_GOOGLE_CLIENT_SECRET,
    });
    const report = await doctor(options(f.root), { ...f.dependencies, googleAPI: google.api });
    expect(status(report)["Google connection"]).toBe("pass");
    expect(status(report)["Google Web client ID"]).toBe("pass");
    expect(status(report)["Google Cloud Android client"]).toBe("warn");
    expect(report.status).toBe("failed");
    expect(JSON.stringify(report)).not.toContain(FAKE_GOOGLE_CLIENT_SECRET);
  });

  test("an unreadable connection is a warning, not a crash", async () => {
    const f = await fixture();
    const report = await doctor(options(f.root), {
      ...f.dependencies,
      googleAPI: {
        fetchInstanceConfig: async () => {
          throw new Error("forbidden");
        },
      } as never,
    });
    expect(report.checks.find((check) => check.name === "Google connection")).toMatchObject({
      status: "warn",
      message: expect.stringContaining("forbidden"),
    });
  });
});
