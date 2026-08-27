import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createIOSFixture } from "../init/ios/test-helpers.ts";
import { PlapiError } from "../../lib/errors.ts";
import type { UserSettingsJSON } from "../../lib/fapi.ts";
import type { Application } from "../../lib/plapi.ts";
import { auditIOSPrebuiltAuthEnvironment } from "../init/ios/prebuilt-auth-environment.ts";
import type { DoctorContext, ResolvedProfile } from "./types.ts";
import { runIOSDoctorChecks, type IOSDoctorDependencies } from "./ios.ts";

const roots: string[] = [];

function publishableKey(host: string, live = false): string {
  return `${live ? "pk_live_" : "pk_test_"}${Buffer.from(`${host}$`).toString("base64")}`;
}

function context(): DoctorContext {
  const profile: ResolvedProfile = {
    path: "fixture",
    resolvedVia: "directory",
    profile: {
      workspaceId: "org_test",
      appId: "app_test",
      instances: { development: "ins_test" },
    },
  };
  const noopFix = () => ({ label: "noop", run: async () => {} });
  return {
    hasPlatformAPIKey: () => false,
    hasAccountCredentials: async () => true,
    verifyPlatformAPIKey: async () => {},
    getToken: async () => "oauth-token",
    getValidToken: async () => "oauth-token",
    getProfile: async () => profile,
    getApplication: async () => null,
    getKeylessTarget: async () => undefined,
    getKeylessInstance: async () => null,
    getKeylessKeyError: async () => undefined,
    hasClaimBreadcrumb: async () => false,
    fixes: { login: noopFix, link: noopFix, envPull: noopFix },
  };
}

async function fixture(options: Parameters<typeof createIOSFixture>[1] = {}): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "clerk-ios-doctor-"));
  roots.push(root);
  await createIOSFixture(root, options);
  return root;
}

async function addAppleEntitlement(root: string): Promise<void> {
  const entitlementsPath = join(root, "MyApp", "MyApp.entitlements");
  const entitlements = await readFile(entitlementsPath, "utf8");
  await writeFile(
    entitlementsPath,
    entitlements.replace(
      "</dict>",
      "<key>com.apple.developer.applesignin</key><array><string>Default</string></array></dict>",
    ),
  );
}

function dependencies(overrides: Partial<IOSDoctorDependencies> = {}): IOSDoctorDependencies {
  const application: Application = {
    application_id: "app_test",
    instances: [
      {
        instance_id: "ins_test",
        environment_type: "development",
        publishable_key: publishableKey("clerk.example.test"),
      },
    ],
  };
  return {
    inspectIOSProject:
      overrides.inspectIOSProject ??
      (async (...args) => {
        const { inspectIOSProject } = await import("../init/ios/inspect.ts");
        return inspectIOSProject(...args);
      }),
    fetchApplication: overrides.fetchApplication ?? (async () => application),
    getNativeSettings:
      overrides.getNativeSettings ??
      (async () => ({ object: "native_settings", api_enabled: true })),
    listIOSApplications:
      overrides.listIOSApplications ??
      (async () => [
        {
          object: "ios_application",
          id: "iosapp_test",
          app_id_prefix: "LEGACY1234",
          bundle_id: "com.example.MyApp",
          created_at: 1,
          updated_at: 1,
        },
      ]),
    fetchUserSettings:
      overrides.fetchUserSettings ?? (async () => ({ social: {} }) as UserSettingsJSON),
    auditIOSPrebuiltAuthEnvironment:
      overrides.auditIOSPrebuiltAuthEnvironment ?? auditIOSPrebuiltAuthEnvironment,
    planIOSAppleEntitlement:
      overrides.planIOSAppleEntitlement ??
      (async () => {
        throw new Error("Apple planner should not run without a local entitlement");
      }),
    auditIOSNativeAppleHealth:
      overrides.auditIOSNativeAppleHealth ??
      (async () => {
        throw new Error("Apple remote audit should not run without a local entitlement");
      }),
  };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("runIOSDoctorChecks", () => {
  test("uses semantic iOS checks instead of web environment checks", async () => {
    const root = await fixture();
    const audit = await runIOSDoctorChecks(context(), { root, target: "MyApp" }, dependencies());

    expect(
      audit.results.some((result) => result.name === "iOS: Select the iOS application target"),
    ).toBeTrue();
    expect(audit.results.some((result) => result.name === "Environment variables")).toBeFalse();
    expect(audit.results.find((result) => result.name === "iOS: Native Application")?.status).toBe(
      "pass",
    );
  });

  test("reports missing Native API and registration as a fixable init requirement", async () => {
    const root = await fixture();
    const audit = await runIOSDoctorChecks(
      context(),
      { root, target: "MyApp" },
      dependencies({
        getNativeSettings: async () => ({ object: "native_settings", api_enabled: false }),
        listIOSApplications: async () => [],
      }),
    );

    const remote = audit.results.find((result) => result.name === "iOS: Native Application");
    expect(remote?.status).toBe("fail");
    expect(remote?.message).toContain("setup required");
    expect(remote?.detail).toContain("Register iOS Bundle ID");
    expect(remote?.remedy).toContain("clerk init");
  });

  test("directs established apps to integrate their missing authentication flow manually", async () => {
    const root = await fixture();
    await writeFile(
      join(root, "MyApp", "ContentView.swift"),
      `import SwiftUI

struct ContentView: View {
  var body: some View {
    NavigationStack {
      List {
        NavigationLink("Profile") { Text("Existing profile flow") }
      }
      .navigationTitle("Settings")
    }
  }
}
`,
    );

    const audit = await runIOSDoctorChecks(context(), { root, target: "MyApp" }, dependencies());
    const authFlow = audit.results.find(
      (result) => result.name === "iOS: Add an authentication flow",
    );

    expect(authFlow?.status).toBe("fail");
    expect(authFlow?.remedy).toContain("signed-out entry point");
    expect(authFlow?.remedy).toContain("AuthView");
    expect(authFlow?.remedy).toContain("custom ClerkKit sign-in/sign-up flow");
    expect(authFlow?.remedy).not.toContain("clerk init");
  });

  test("does not call remote endpoints until one target is selected", async () => {
    const root = await fixture({ secondTarget: true });
    let remoteCalls = 0;
    const audit = await runIOSDoctorChecks(
      context(),
      { root },
      dependencies({
        getNativeSettings: async () => {
          remoteCalls++;
          return { object: "native_settings", api_enabled: true };
        },
        listIOSApplications: async () => {
          remoteCalls++;
          return [];
        },
      }),
    );

    expect(remoteCalls).toBe(0);
    expect(
      audit.results.find((result) => result.name === "iOS: Select the iOS application target")
        ?.status,
    ).toBe("fail");
    expect(
      audit.results.find((result) => result.name === "iOS: Native Application")?.message,
    ).toContain("select one iOS target");
  });

  test("keeps a conflicting local Bundle ID failure when remote state is unavailable", async () => {
    const root = await fixture({ conflictingBundle: true });
    let remoteCalls = 0;
    const audit = await runIOSDoctorChecks(
      context(),
      { root, target: "MyApp" },
      dependencies({
        getNativeSettings: async () => {
          remoteCalls++;
          throw new Error("should not inspect remote state");
        },
        listIOSApplications: async () => {
          remoteCalls++;
          throw new Error("should not inspect remote state");
        },
      }),
    );

    expect(remoteCalls).toBe(0);
    const registration = audit.results.find(
      (result) => result.name === "iOS: Register the iOS app in Clerk Dashboard",
    );
    expect(registration?.status).toBe("fail");
    expect(registration?.message).toContain("blocked");
    expect(registration?.detail).toContain("single Bundle ID");
  });

  test("fails locally on conflicting literal App ID Prefix evidence without remote reads", async () => {
    const root = await fixture();
    let remoteCalls = 0;
    const audit = await runIOSDoctorChecks(
      context(),
      { root, target: "MyApp" },
      dependencies({
        inspectIOSProject: async (...args) => {
          const { inspectIOSProject } = await import("../init/ios/inspect.ts");
          const inspection = await inspectIOSProject(...args);
          return {
            ...inspection,
            appTargets: inspection.appTargets.map((target) => ({
              ...target,
              configurations: target.configurations.map((configuration, index) => ({
                ...configuration,
                ...(configuration.entitlements
                  ? {
                      entitlements: {
                        ...configuration.entitlements,
                        literalAppIdentifierPrefix: index === 0 ? "LEGACY1234" : "OTHER12345",
                      },
                    }
                  : {}),
              })),
            })),
          };
        },
        getNativeSettings: async () => {
          remoteCalls++;
          throw new Error("should not inspect remote state");
        },
        listIOSApplications: async () => {
          remoteCalls++;
          throw new Error("should not inspect remote state");
        },
      }),
    );

    expect(remoteCalls).toBe(0);
    const prefix = audit.results.find((result) => result.name === "iOS: App ID Prefix evidence");
    expect(prefix?.status).toBe("fail");
    expect(prefix?.message).toContain("conflicting values");
    expect(JSON.stringify(audit.results)).not.toContain("OTHER12345");
  });

  test("redacts keys while diagnosing a linked development-key mismatch", async () => {
    const root = await fixture({ complete: true, includeKey: false, localSecrets: true });
    const secret = "sk_test_must_never_escape";
    const audit = await runIOSDoctorChecks(
      context(),
      { root, target: "MyApp" },
      dependencies({
        fetchApplication: async () => ({
          application_id: "app_test",
          instances: [
            {
              instance_id: "ins_test",
              environment_type: "development",
              publishable_key: publishableKey("native.clerk.example"),
              secret_key: secret,
            },
          ],
        }),
      }),
    );

    const key = audit.results.find((result) => result.name === "iOS: Linked development key");
    expect(key?.status).toBe("fail");
    expect(key?.message).toContain("different Clerk instance");
    expect(JSON.stringify(audit.results)).not.toContain("pk_");
    expect(JSON.stringify(audit.results)).not.toContain(secret);
  });

  test("does not use an available-only key candidate to inspect AuthView methods", async () => {
    const root = await fixture({ complete: true });
    let environmentCalls = 0;
    const audit = await runIOSDoctorChecks(
      context(),
      { root, target: "MyApp" },
      dependencies({
        fetchUserSettings: async () => {
          environmentCalls++;
          return { social: {} } as UserSettingsJSON;
        },
      }),
    );

    expect(environmentCalls).toBe(0);
    const methods = audit.results.find(
      (result) => result.name === "iOS: AuthView authentication methods",
    );
    expect(methods?.status).toBe("warn");
    expect(methods?.message).toContain("runtime key was not proven");
  });

  test("fails when AuthView offers Apple but the selected target lacks its entitlement", async () => {
    const root = await fixture({ complete: true, includeKey: false, localSecrets: true });
    let environmentCalls = 0;
    let appleHealthCalls = 0;
    const audit = await runIOSDoctorChecks(
      context(),
      { root, target: "MyApp" },
      dependencies({
        fetchUserSettings: async () => {
          environmentCalls++;
          return {
            social: {
              oauth_apple: {
                enabled: true,
                authenticatable: true,
                strategy: "oauth_apple",
                private_key: "apple-private-material-must-not-escape",
              },
            },
          } as unknown as UserSettingsJSON;
        },
        auditIOSNativeAppleHealth: async () => {
          appleHealthCalls++;
          throw new Error("Apple health must wait for the local entitlement");
        },
      }),
    );

    expect(environmentCalls).toBe(1);
    expect(appleHealthCalls).toBe(0);
    const methods = audit.results.find(
      (result) => result.name === "iOS: AuthView authentication methods",
    );
    expect(methods?.status).toBe("fail");
    expect(methods?.message).toContain("lacks its entitlement");
    expect(methods?.remedy).toContain("--sign-in-with-apple");
    expect(JSON.stringify(audit.results)).not.toContain("apple-private-material-must-not-escape");
  });

  test("audits public AuthView methods even before the local project is linked", async () => {
    const root = await fixture({ complete: true, includeKey: false, localSecrets: true });
    let environmentCalls = 0;
    let nativeCalls = 0;
    const unlinkedContext: DoctorContext = {
      ...context(),
      getProfile: async () => undefined,
    };
    const audit = await runIOSDoctorChecks(
      unlinkedContext,
      { root, target: "MyApp" },
      dependencies({
        fetchUserSettings: async () => {
          environmentCalls++;
          return {
            social: {
              oauth_apple: {
                enabled: true,
                authenticatable: true,
                strategy: "oauth_apple",
              },
            },
          } as unknown as UserSettingsJSON;
        },
        getNativeSettings: async () => {
          nativeCalls++;
          return { object: "native_settings", api_enabled: true };
        },
        listIOSApplications: async () => {
          nativeCalls++;
          return [];
        },
      }),
    );

    expect(environmentCalls).toBe(1);
    expect(nativeCalls).toBe(0);
    expect(
      audit.results.find((result) => result.name === "iOS: AuthView authentication methods")
        ?.status,
    ).toBe("fail");
    expect(audit.results.find((result) => result.name === "iOS: Native Application")?.status).toBe(
      "warn",
    );
  });

  test("does not infer AuthView from a custom native authentication call", async () => {
    const root = await fixture();
    await writeFile(
      join(root, "MyApp", "MyAppApp.swift"),
      `import SwiftUI
import ClerkKit

@main
struct MyApp: App {
  var body: some Scene { WindowGroup { Text("Hello") } }
  func signIn() async throws { try await Clerk.shared.signInWithApple() }
}
`,
    );
    let environmentCalls = 0;
    const audit = await runIOSDoctorChecks(
      context(),
      { root, target: "MyApp" },
      dependencies({
        fetchUserSettings: async () => {
          environmentCalls++;
          return { social: {} } as UserSettingsJSON;
        },
      }),
    );

    expect(environmentCalls).toBe(0);
    expect(
      audit.results.some((result) => result.name === "iOS: AuthView authentication methods"),
    ).toBeFalse();
  });

  test("warns without leaking transport details when AuthView settings are unavailable", async () => {
    const root = await fixture({ complete: true, includeKey: false, localSecrets: true });
    const audit = await runIOSDoctorChecks(
      context(),
      { root, target: "MyApp" },
      dependencies({
        fetchUserSettings: async () => {
          throw new TypeError("fetch failed with token authview-transport-secret");
        },
      }),
    );

    const methods = audit.results.find(
      (result) => result.name === "iOS: AuthView authentication methods",
    );
    expect(methods?.status).toBe("warn");
    expect(methods?.message).toContain("could not be inspected");
    expect(JSON.stringify(audit.results)).not.toContain("authview-transport-secret");
  });

  test("audits the Clerk Apple connection only when the local entitlement is present", async () => {
    const root = await fixture();
    await addAppleEntitlement(root);
    let appleCalls = 0;
    const audit = await runIOSDoctorChecks(
      context(),
      { root, target: "MyApp" },
      dependencies({
        planIOSAppleEntitlement: async (options) => {
          const { planIOSAppleEntitlement } = await import("../init/ios/apple-entitlement.ts");
          return planIOSAppleEntitlement(options);
        },
        auditIOSNativeAppleHealth: async ({ applicationId, instanceId, bundleIdentifier }) => {
          appleCalls++;
          return {
            schemaVersion: 1,
            kind: "clerk-ios-native-apple-health",
            applicationId,
            instanceId,
            bundleIdentifier,
            runtime: {
              status: "satisfied",
              connection: "satisfied",
              bundleIdentifierConfiguration: "satisfied",
              current: { enabled: true, authenticatable: true },
              blockers: [],
            },
            automation: { status: "supported", configVersion: "v1_12345678", blockers: [] },
          };
        },
      }),
    );

    expect(appleCalls).toBe(1);
    expect(
      audit.results.find((result) => result.name === "iOS: Sign in with Apple entitlement")?.status,
    ).toBe("pass");
    expect(
      audit.results.find((result) => result.name === "iOS: Clerk Sign in with Apple")?.status,
    ).toBe("pass");
  });

  test("classifies access errors without exposing the API response body", async () => {
    const root = await fixture();
    const sensitiveBody = '{"errors":[{"message":"Bearer secret-token-value"}]}';
    const audit = await runIOSDoctorChecks(
      context(),
      { root, target: "MyApp" },
      dependencies({
        getNativeSettings: async () => {
          throw new PlapiError(403, sensitiveBody);
        },
      }),
    );

    const remote = audit.results.find((result) => result.name === "iOS: Native Application");
    expect(remote?.status).toBe("fail");
    expect(remote?.message).toContain("not permitted");
    expect(remote?.remedy).toContain("applications:read");
    expect(JSON.stringify(audit.results)).not.toContain("secret-token-value");
  });

  test("fails when a local Apple entitlement has no matching Clerk connection", async () => {
    const root = await fixture();
    await addAppleEntitlement(root);
    const audit = await runIOSDoctorChecks(
      context(),
      { root, target: "MyApp" },
      dependencies({
        planIOSAppleEntitlement: async (options) => {
          const { planIOSAppleEntitlement } = await import("../init/ios/apple-entitlement.ts");
          return planIOSAppleEntitlement(options);
        },
        auditIOSNativeAppleHealth: async ({ applicationId, instanceId, bundleIdentifier }) => ({
          schemaVersion: 1,
          kind: "clerk-ios-native-apple-health",
          applicationId,
          instanceId,
          bundleIdentifier,
          runtime: {
            status: "required",
            connection: "required",
            bundleIdentifierConfiguration: "required",
            current: { enabled: true, authenticatable: true },
            blockers: [],
          },
          automation: { status: "supported", configVersion: "v1_12345678", blockers: [] },
        }),
      }),
    );

    const apple = audit.results.find((result) => result.name === "iOS: Clerk Sign in with Apple");
    expect(apple?.status).toBe("fail");
    expect(apple?.message).toContain("not bound to the selected Bundle ID");
  });

  test("fails Apple permission errors without exposing the API response body", async () => {
    const root = await fixture();
    await addAppleEntitlement(root);
    const sensitiveBody = '{"errors":[{"message":"Bearer apple-secret-value"}]}';
    const audit = await runIOSDoctorChecks(
      context(),
      { root, target: "MyApp" },
      dependencies({
        planIOSAppleEntitlement: async (options) => {
          const { planIOSAppleEntitlement } = await import("../init/ios/apple-entitlement.ts");
          return planIOSAppleEntitlement(options);
        },
        auditIOSNativeAppleHealth: async () => {
          throw new PlapiError(403, sensitiveBody);
        },
      }),
    );

    const apple = audit.results.find((result) => result.name === "iOS: Clerk Sign in with Apple");
    expect(apple?.status).toBe("fail");
    expect(apple?.message).toContain("not permitted");
    expect(apple?.remedy).toContain("applications:read");
    expect(JSON.stringify(audit.results)).not.toContain("apple-secret-value");
  });
});
