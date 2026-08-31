import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inspectIOSProject } from "./inspect.ts";
import type { IOSAssociatedDomainPlan } from "./associated-domain.ts";
import {
  buildIOSNativeReadinessAudit,
  IOS_NATIVE_READINESS_PLAPI_BRIDGE_REQUIREMENT,
  suggestAppIdPrefixFromDevelopmentTeam,
} from "./native-readiness.ts";
import { createIOSFixture, IOS_FIXTURE_IDS } from "./test-helpers.ts";

const temporaryDirectories: string[] = [];

async function inspectionFor(
  options: Parameters<typeof createIOSFixture>[1] = {},
  target?: string,
) {
  const root = await mkdtemp(join(tmpdir(), "clerk-ios-native-readiness-"));
  temporaryDirectories.push(root);
  await createIOSFixture(root, options);
  return inspectIOSProject(root, { target });
}

async function inspectionWithInlineKey(options: Parameters<typeof createIOSFixture>[1] = {}) {
  const root = await mkdtemp(join(tmpdir(), "clerk-ios-native-readiness-inline-"));
  temporaryDirectories.push(root);
  await createIOSFixture(root, { ...options, complete: false, includeKey: false });
  const encodedHost = Buffer.from("native.clerk.example$").toString("base64");
  await Bun.write(
    join(root, "MyApp", "MyAppApp.swift"),
    `import ClerkKit
import SwiftUI

@main
struct MyApp: App {
  init() { Clerk.configure(publishableKey: "pk_test_${encodedHost}") }
  var body: some Scene { WindowGroup { Text("Hello") } }
}
`,
  );
  return inspectIOSProject(root, { target: "MyApp" });
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true })));
});

describe("buildIOSNativeReadinessAudit", () => {
  test("reports a redacted selected-target identity and the exact authenticated PLAPI bridge", async () => {
    const inspection = await inspectionFor({ complete: true });
    const selected = inspection.appTargets[0]!;
    for (const configuration of selected.configurations) {
      configuration.developmentTeam = {
        state: "resolved",
        value: "DEVELOPMENT_TEAM_MUST_NOT_ESCAPE",
        evidence: [],
      };
      if (configuration.entitlements) {
        configuration.entitlements.teamIdentifier = "ENTITLEMENTS_TEAM_MUST_NOT_ESCAPE";
      }
    }

    const audit = buildIOSNativeReadinessAudit(inspection);

    expect(audit).toMatchObject({
      schemaVersion: 1,
      kind: "clerk-ios-native-readiness",
      root: inspection.root,
      target: {
        status: "selected",
        projectPath: "MyApp.xcodeproj",
        targetId: IOS_FIXTURE_IDS.appTarget,
        targetName: "MyApp",
        bundleIdentifier: { status: "resolved", value: "com.example.MyApp" },
        appIdPrefix: {
          status: "resolved",
          source: "literal-entitlements",
          value: "LEGACY1234",
        },
      },
      associatedDomain: {
        status: "blocked",
        files: ["MyApp/MyApp.entitlements"],
        automatable: false,
        blockers: [
          {
            code: "expected-domain-unavailable",
            message:
              "A proven local publishable key is required to derive the webcredentials domain.",
          },
        ],
      },
      remote: {
        status: "not-inspected",
        reason: "dry-run-does-not-read-remote-state",
        requirement: IOS_NATIVE_READINESS_PLAPI_BRIDGE_REQUIREMENT,
      },
    });
    expect(audit.associatedDomain.expectedDomain).toBeUndefined();
    expect(audit.remote.requirement).toEqual({
      applicationId: "linked-application-id",
      instanceId: "linked-development-instance-id",
      authentication: "clerk-cli-bearer-token",
      scope: "applications:read",
      reads: [
        {
          method: "GET",
          path: "/v1/platform/applications/{applicationId}/instances/{instanceId}/native_settings",
          provides: "native-api-state",
        },
        {
          method: "GET",
          path: "/v1/platform/applications/{applicationId}/instances/{instanceId}/native_applications/ios",
          provides: "ios-native-applications",
        },
      ],
    });
    expect(JSON.stringify(audit)).not.toContain("DEVELOPMENT_TEAM_MUST_NOT_ESCAPE");
    expect(JSON.stringify(audit)).not.toContain("ENTITLEMENTS_TEAM_MUST_NOT_ESCAPE");
  });

  test("offers one unanimous Xcode Development Team only as an unverified suggestion", async () => {
    const inspection = await inspectionFor({ complete: true });
    const target = inspection.appTargets[0]!;

    expect(suggestAppIdPrefixFromDevelopmentTeam(target)).toEqual({
      source: "xcode-development-team",
      value: "ABCDE12345",
    });
    expect(JSON.stringify(buildIOSNativeReadinessAudit(inspection))).not.toContain("ABCDE12345");
  });

  test("withholds the Xcode Development Team suggestion unless every configuration agrees", async () => {
    const inspection = await inspectionFor({ complete: true });
    const target = inspection.appTargets[0]!;
    target.configurations[1]!.developmentTeam = {
      state: "resolved",
      value: "ZZZZZ99999",
      evidence: [],
    };
    expect(suggestAppIdPrefixFromDevelopmentTeam(target)).toBeUndefined();

    target.configurations[1]!.developmentTeam = { state: "missing", evidence: [] };
    expect(suggestAppIdPrefixFromDevelopmentTeam(target)).toBeUndefined();

    target.configurations[1]!.developmentTeam = {
      state: "unresolved",
      raw: "$(APPLE_TEAM)",
      missingVariables: ["APPLE_TEAM"],
      evidence: [],
    };
    expect(suggestAppIdPrefixFromDevelopmentTeam(target)).toBeUndefined();

    for (const configuration of target.configurations) {
      configuration.developmentTeam = {
        state: "resolved",
        value: "NOT-A-TEAM",
        evidence: [],
      };
    }
    expect(suggestAppIdPrefixFromDevelopmentTeam(target)).toBeUndefined();
  });

  test("requires the bare domain when only Apple's developer-mode entry is present", async () => {
    const inspection = await inspectionWithInlineKey();
    for (const configuration of inspection.appTargets[0]!.configurations) {
      configuration.entitlements!.associatedDomains = [
        "webcredentials:native.clerk.example?mode=developer",
      ];
    }

    const audit = buildIOSNativeReadinessAudit(inspection);

    expect(audit.associatedDomain).toEqual({
      status: "required",
      expectedDomain: "webcredentials:native.clerk.example",
      files: ["MyApp/MyApp.entitlements"],
      automatable: true,
      blockers: [],
    });
  });

  test("recognizes the exact bare domain as locally satisfied", async () => {
    const inspection = await inspectionWithInlineKey();
    for (const configuration of inspection.appTargets[0]!.configurations) {
      configuration.entitlements!.associatedDomains = ["webcredentials:native.clerk.example"];
    }

    const audit = buildIOSNativeReadinessAudit(inspection);

    expect(audit.associatedDomain).toEqual({
      status: "satisfied",
      expectedDomain: "webcredentials:native.clerk.example",
      files: ["MyApp/MyApp.entitlements"],
      automatable: false,
      blockers: [],
    });
  });

  test("does not satisfy readiness with a differently cased service token", async () => {
    const inspection = await inspectionWithInlineKey();
    for (const configuration of inspection.appTargets[0]!.configurations) {
      configuration.entitlements!.associatedDomains = ["WEBCREDENTIALS:native.clerk.example"];
    }

    const audit = buildIOSNativeReadinessAudit(inspection);

    expect(audit.associatedDomain).toMatchObject({
      status: "required",
      expectedDomain: "webcredentials:native.clerk.example",
    });
  });

  test("blocks automation when configurations have mixed entitlements evidence", async () => {
    const inspection = await inspectionWithInlineKey();
    const target = inspection.appTargets[0]!;
    target.configurations[1]!.entitlements = undefined;

    const audit = buildIOSNativeReadinessAudit(inspection);

    expect(audit.associatedDomain.status).toBe("required");
    expect(audit.associatedDomain.automatable).toBe(false);
    expect(audit.associatedDomain.files).toEqual(["MyApp/MyApp.entitlements"]);
    expect(audit.associatedDomain.blockers).toContainEqual(
      expect.objectContaining({ code: "missing-or-unreadable-entitlements" }),
    );
  });

  test("carries a strict Associated Domains blocker into native readiness", async () => {
    const inspection = await inspectionFor({ complete: true });
    const associatedDomainPlan: IOSAssociatedDomainPlan = {
      schemaVersion: 1,
      kind: "clerk-ios-associated-domain",
      status: "blocked",
      root: inspection.root,
      projectPath: "MyApp.xcodeproj",
      targetId: IOS_FIXTURE_IDS.appTarget,
      targetName: "MyApp",
      requiresPublishableKey: false,
      files: [],
      actions: [],
      blockers: [{ code: "generated-project", message: "Update the project source definition." }],
    };

    const audit = buildIOSNativeReadinessAudit(inspection, { associatedDomainPlan });

    expect(audit.associatedDomain).toMatchObject({ status: "review", automatable: false });
    expect(audit.associatedDomain.blockers).toContainEqual({
      code: "manual-review-required",
      message: "Update the project source definition.",
    });
  });

  test("preserves all distinct existing XML entitlements routes", async () => {
    const inspection = await inspectionWithInlineKey();
    const target = inspection.appTargets[0]!;
    const release = target.configurations[1]!;
    release.entitlements = {
      ...release.entitlements!,
      path: "MyApp/MyApp-Release.entitlements",
      associatedDomains: [],
    };

    const audit = buildIOSNativeReadinessAudit(inspection);

    expect(audit.associatedDomain).toMatchObject({
      status: "required",
      automatable: true,
      files: ["MyApp/MyApp-Release.entitlements", "MyApp/MyApp.entitlements"],
      blockers: [],
    });
  });

  test("does not claim a single bundle identifier or App ID Prefix when they conflict", async () => {
    const inspection = await inspectionFor({ complete: true, conflictingBundle: true });
    const target = inspection.appTargets[0]!;
    target.configurations[1]!.entitlements = {
      ...target.configurations[1]!.entitlements!,
      literalAppIdentifierPrefix: "OTHERPREFIX",
    };

    const audit = buildIOSNativeReadinessAudit(inspection);

    expect(audit.target).toMatchObject({
      status: "selected",
      bundleIdentifier: {
        status: "conflicting",
        candidates: ["com.example.MyApp", "com.example.MyApp.release"],
      },
      appIdPrefix: {
        status: "conflicting",
        source: "literal-entitlements",
        candidates: ["LEGACY1234", "OTHERPREFIX"],
      },
    });
  });

  test("treats case-only Bundle ID variants as one identity and preserves the first spelling", async () => {
    const inspection = await inspectionFor({ complete: true });
    const target = inspection.appTargets[0]!;
    target.configurations[0]!.bundleIdentifier = {
      state: "resolved",
      value: "com.Example.MyApp",
      evidence: [],
    };
    target.configurations[1]!.bundleIdentifier = {
      state: "resolved",
      value: "COM.EXAMPLE.MYAPP",
      evidence: [],
    };

    const audit = buildIOSNativeReadinessAudit(inspection);

    expect(audit.target).toMatchObject({
      status: "selected",
      bundleIdentifier: { status: "resolved", value: "com.Example.MyApp" },
    });
  });

  test("preserves a partial App ID Prefix candidate when one selected configuration lacks it", async () => {
    const inspection = await inspectionFor({ complete: true });
    const releaseEntitlements = inspection.appTargets[0]!.configurations[1]!.entitlements!;
    delete releaseEntitlements.literalAppIdentifierPrefix;

    const audit = buildIOSNativeReadinessAudit(inspection);

    expect(audit.target).toMatchObject({
      status: "selected",
      appIdPrefix: {
        status: "missing",
        source: "literal-entitlements",
        candidates: ["LEGACY1234"],
      },
    });
  });

  test("blocks identity and entitlement routing when target selection is ambiguous", async () => {
    const inspection = await inspectionFor({ secondTarget: true });

    const audit = buildIOSNativeReadinessAudit(inspection);

    expect(audit.target).toEqual({ status: "blocked", reason: "target-not-selected" });
    expect(audit.associatedDomain).toMatchObject({
      status: "blocked",
      files: [],
      automatable: false,
    });
    expect(audit.associatedDomain.blockers).toContainEqual(
      expect.objectContaining({ code: "target-not-selected" }),
    );
  });

  test("does not invent a domain without redacted publishable-key metadata", async () => {
    const inspection = await inspectionFor({ complete: false, includeKey: false });

    const audit = buildIOSNativeReadinessAudit(inspection);

    expect(audit.associatedDomain.expectedDomain).toBeUndefined();
    expect(audit.associatedDomain.status).toBe("blocked");
    expect(audit.associatedDomain.automatable).toBe(false);
    expect(audit.associatedDomain.blockers).toContainEqual(
      expect.objectContaining({ code: "expected-domain-unavailable" }),
    );
  });

  test("never copies an unexpected raw publishable-key property", async () => {
    const inspection = await inspectionFor({ complete: true });
    const key = `pk_test_${Buffer.from("must-not-escape.example$").toString("base64")}`;
    (inspection.localPublishableKey as unknown as Record<string, unknown>).publishableKey = key;

    const audit = buildIOSNativeReadinessAudit(inspection);

    expect(JSON.stringify(audit)).not.toContain(key);
    expect(JSON.stringify(audit)).not.toContain("publishableKey");
  });
});
