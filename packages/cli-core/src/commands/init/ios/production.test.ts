import { afterAll, afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { IOSApplication } from "../../../lib/plapi.ts";
import { runIOSDoctorChecks } from "../../doctor/ios.ts";
import type { DoctorContext } from "../../doctor/types.ts";
import * as coordinator from "./coordinator.ts";
import { doctor } from "./doctor.ts";
import { auditProduction } from "./production.ts";
import type { NativeAPI } from "./remote.ts";
import { createIOSFixture } from "./test-helpers.ts";
import { inspectSelectedProject, type CommandRunner } from "./xcode.ts";

const DEV = `pk_test_${btoa("clerk.example.test$")}`;
const LIVE = `pk_live_${btoa("clerk.example.com$")}`;
const OTHER_LIVE = `pk_live_${btoa("clerk.other.com$")}`;
const PRODUCTION_DOMAIN = "webcredentials:clerk.example.com";

const ENTITLEMENTS = (domains: string[]) =>
  `<?xml version="1.0" encoding="UTF-8"?>\n<plist version="1.0"><dict>\n\t<key>com.apple.developer.associated-domains</key>\n\t<array>${domains.map((domain) => `<string>${domain}</string>`).join("")}</array>\n</dict></plist>\n`;

interface Fixture {
  production: boolean;
  nativeEnabled: boolean;
  registrations: IOSApplication[];
  release: Record<string, string>;
  swift: string;
}

const xcode = spyOn(coordinator, "canSetUpXcode").mockReturnValue(true);
afterAll(() => xcode.mockRestore());

let root: string;
let state: Fixture;
beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "clerk-production-")));
  await createIOSFixture(root, { clerkSDK: false, includeKey: false });
  state = {
    production: true,
    nativeEnabled: true,
    registrations: [registration("com.example.MyApp")],
    release: {},
    swift: `#if DEBUG\nClerk.configure(publishableKey: "${DEV}")\n#else\nClerk.configure(publishableKey: "${LIVE}")\n#endif\n`,
  };
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function registration(bundle: string, prefix = "ABCDE12345"): IOSApplication {
  return {
    object: "ios_application",
    id: `ios_${bundle}`,
    bundle_id: bundle,
    app_id_prefix: prefix,
  };
}

const api: NativeAPI = {
  async fetchApplication(id) {
    return {
      application_id: id,
      instances: [
        { instance_id: "ins_dev", environment_type: "development", publishable_key: DEV },
        ...(state.production
          ? [{ instance_id: "ins_prod", environment_type: "production", publishable_key: LIVE }]
          : []),
      ],
    };
  },
  async getNativeSettings(_app, instance) {
    return {
      object: "native_settings",
      api_enabled: instance === "ins_dev" || state.nativeEnabled,
    };
  },
  async listIOSApplications(_app, instance) {
    return instance === "ins_dev" ? [registration("com.example.MyApp")] : state.registrations;
  },
  async createIOSApplication() {
    throw new Error("Doctor must not register applications.");
  },
  async enableNativeApi() {
    throw new Error("Doctor must not enable Native API.");
  },
};

// Synthetic resolved settings for the fixture's two configurations.
const run: CommandRunner = async (command) => {
  const configuration = command[command.indexOf("-configuration") + 1]!;
  return JSON.stringify([
    {
      target: "MyApp",
      buildSettings: {
        TARGET_NAME: "MyApp",
        PRODUCT_BUNDLE_IDENTIFIER: "com.example.MyApp",
        DEVELOPMENT_TEAM: "ABCDE12345",
        GENERATE_INFOPLIST_FILE: "YES",
        SRCROOT: root,
        CONFIGURATION: configuration,
        PLATFORM_NAME: "iphoneos",
        PROJECT_FILE_PATH: join(root, "MyApp.xcodeproj"),
        PRODUCT_TYPE: "com.apple.product-type.application",
        IPHONEOS_DEPLOYMENT_TARGET: "17.0",
        CODE_SIGN_ENTITLEMENTS: "MyApp/MyApp.entitlements",
        ...(configuration === "Debug" ? { SWIFT_ACTIVE_COMPILATION_CONDITIONS: "DEBUG" } : {}),
        ...(configuration === "Release" ? state.release : {}),
      },
    },
  ]);
};

async function audit() {
  await writeFile(join(root, "MyApp/MyAppApp.swift"), state.swift);
  const inspection = await inspectSelectedProject(
    { root, products: "core", minimumVersion: "1.0.0" },
    run,
  );
  const checks = await auditProduction(inspection, { applicationId: "app_test" }, api);
  return Object.fromEntries(checks.map((check) => [check.name, check]));
}

async function withProductionDomain() {
  await writeFile(
    join(root, "MyApp/MyApp.entitlements"),
    ENTITLEMENTS(["webcredentials:clerk.example.test", PRODUCTION_DOMAIN]),
  );
}

test("a Release build ready for production passes every check", async () => {
  await withProductionDomain();
  const checks = await audit();
  expect(Object.keys(checks)).toEqual([
    "Production native registration",
    "Production associated domain: Release",
    "Production publishable key: Release",
  ]);
  expect(Object.values(checks).map((check) => check.status)).toEqual(["pass", "pass", "pass"]);
  expect(checks["Production publishable key: Release"]?.message).toBe(
    "Release uses the production instance's publishable key (from a string literal in MyApp/MyAppApp.swift).",
  );
});

test("without a production instance, one passing note replaces the checks", async () => {
  state.production = false;
  const checks = Object.values(await audit());
  expect(checks).toEqual([
    expect.objectContaining({ name: "Production instance", status: "pass" }),
  ]);
  expect(checks[0]?.message).toContain("clerk deploy");
});

describe("production native registration", () => {
  test.each([
    {
      name: "a missing registration",
      registrations: [],
      nativeEnabled: true,
      message:
        "com.example.MyApp (App ID Prefix ABCDE12345) isn't registered on the production instance.",
    },
    {
      name: "Native API disabled",
      registrations: [registration("com.example.MyApp")],
      nativeEnabled: false,
      message: "Native API is disabled on the production instance.",
    },
    {
      name: "a registration that differs in letter case",
      registrations: [registration("com.example.myapp")],
      nativeEnabled: true,
      message: "differs in capitalization",
    },
  ])("warns about $name", async ({ registrations, nativeEnabled, message }) => {
    Object.assign(state, { registrations, nativeEnabled });
    const check = (await audit())["Production native registration"];
    expect(check?.status).toBe("warn");
    expect(check?.message).toContain(message);
    expect(check?.remedy).toContain("/instances/ins_prod/native-applications");
  });

  test("checks the Release Bundle ID, not Debug's", async () => {
    state.release = { PRODUCT_BUNDLE_IDENTIFIER: "com.example.MyApp.store" };
    state.registrations = [registration("com.example.MyApp.store")];
    expect((await audit())["Production native registration"]?.message).toContain(
      "com.example.MyApp.store is registered",
    );
  });
});

describe("production associated domain", () => {
  test("warns when the shared entitlements list only the development domain", async () => {
    const check = (await audit())["Production associated domain: Release"];
    expect(check).toMatchObject({ status: "warn" });
    expect(check?.message).toContain(`don't include ${PRODUCTION_DOMAIN}`);
    expect(check?.remedy).toContain("Associated Domains for Release");
  });

  test("reads Release's own entitlements file", async () => {
    await writeFile(join(root, "MyApp/Release.entitlements"), ENTITLEMENTS([PRODUCTION_DOMAIN]));
    state.release = { CODE_SIGN_ENTITLEMENTS: "MyApp/Release.entitlements" };
    expect((await audit())["Production associated domain: Release"]?.status).toBe("pass");
  });

  test.each([
    {
      name: "expands a build setting to the production host",
      host: "clerk.example.com",
      status: "pass",
    },
    {
      name: "still warns when the setting resolves elsewhere",
      host: "clerk.example.test",
      status: "warn",
    },
    { name: "still warns when the setting is unset", host: undefined, status: "warn" },
  ])("$name", async ({ host, status }) => {
    await writeFile(
      join(root, "MyApp/MyApp.entitlements"),
      ENTITLEMENTS(["webcredentials:$(CLERK_FAPI_HOST)"]),
    );
    if (host) state.release = { CLERK_FAPI_HOST: host };
    expect((await audit())["Production associated domain: Release"]?.status).toBe(status);
  });

  test("warns when Release signs without entitlements", async () => {
    state.release = { CODE_SIGN_ENTITLEMENTS: "" };
    expect((await audit())["Production associated domain: Release"]?.message).toBe(
      `Release signs without an entitlements file, so it lacks ${PRODUCTION_DOMAIN}.`,
    );
  });
});

describe("production publishable key", () => {
  test.each([
    {
      name: "the development key",
      swift: `Clerk.configure(publishableKey: "${DEV}")`,
      message:
        "Release uses a development publishable key (from a string literal in MyApp/MyAppApp.swift)",
    },
    {
      name: "another instance's production key",
      swift: `Clerk.configure(publishableKey: "${OTHER_LIVE}")`,
      message: "the production publishable key of a different instance (clerk.other.com",
    },
    {
      name: "a key loaded at runtime",
      swift: `Clerk.configure(publishableKey: ProcessInfo.processInfo.environment["KEY"] ?? "")`,
      message: "Not verified: Clerk.configure in MyApp/MyAppApp.swift gets its key from code",
    },
  ])("warns about $name without printing keys", async ({ swift, message }) => {
    state.swift = swift;
    const check = (await audit())["Production publishable key: Release"];
    expect(check?.status).toBe("warn");
    expect(check?.message).toContain(message);
    expect(check?.remedy).toContain("CLERK_PUBLISHABLE_KEY build setting");
    expect(JSON.stringify(check)).not.toMatch(/pk_(test|live)_[A-Za-z0-9]/);
  });

  test("follows an Info.plist entry to Release's build setting", async () => {
    await writeFile(
      join(root, "MyApp/Info.plist"),
      `<?xml version="1.0" encoding="UTF-8"?>\n<plist version="1.0"><dict><key>ClerkPublishableKey</key><string>$(CLERK_PUBLISHABLE_KEY)</string></dict></plist>\n`,
    );
    state.swift = `Clerk.configure(publishableKey: Bundle.main.object(forInfoDictionaryKey: "ClerkPublishableKey") as! String)`;
    state.release = { INFOPLIST_FILE: "MyApp/Info.plist", CLERK_PUBLISHABLE_KEY: LIVE };
    expect((await audit())["Production publishable key: Release"]).toMatchObject({
      status: "pass",
      message:
        "Release uses the production instance's publishable key (from the Info.plist entry ClerkPublishableKey, set by the CLERK_PUBLISHABLE_KEY build setting).",
    });
  });
});

test("doctor appends the production checks after the development ones", async () => {
  await writeFile(join(root, "MyApp/MyAppApp.swift"), state.swift);
  const report = await doctor(
    {
      root,
      products: "core",
      minimumVersion: "1.0.0",
      inspectOnly: true,
      remote: { applicationId: "app_test" },
    },
    { api, run },
  );
  const names = report.checks.map((check) => check.name);
  expect(names.slice(-3)).toEqual([
    "Production native registration",
    "Production associated domain: Release",
    "Production publishable key: Release",
  ]);
  expect(report.checks.find((check) => check.name === "Native identity")?.status).toBe("pass");
});

test("clerk doctor shows each production check's own remedy, not clerk init's", async () => {
  await writeFile(join(root, "MyApp/MyAppApp.swift"), state.swift);
  const ctx = {
    getProfile: async () => ({ profile: { appId: "app_test" } }),
  } as unknown as DoctorContext;
  const results = await runIOSDoctorChecks(ctx, { root }, { api, run });
  const domain = results.find((result) => result.name === "Production associated domain: Release");
  expect(domain?.status).toBe("warn");
  expect(domain?.remedy).toContain("Associated Domains for Release");
  expect(results.find((result) => result.name === "Production native registration")).toMatchObject({
    status: "pass",
    remedy: undefined,
  });
});
