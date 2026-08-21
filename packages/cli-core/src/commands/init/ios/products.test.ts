import { describe, expect, test } from "bun:test";
import {
  clerkKitUIInstallDecision,
  hasIOSDirectConfigCompatibility,
  shouldInstallClerkKitUI,
  shouldPlanIOSDirectConfig,
} from "./products.ts";
import type { IOSAppTarget, IOSProjectInspectionResult } from "./types.ts";

function target(): IOSAppTarget {
  return {
    id: "TARGET",
    name: "MyApp",
    projectPath: "MyApp.xcodeproj",
    configurations: [],
    packages: { package: "absent", clerkKit: "absent", clerkKitUI: "absent" },
    runtimeKeySinks: [],
    swift: {
      sourceFilesScanned: 1,
      evidenceComplete: true,
      entryPoints: [{ path: "MyApp/MyAppApp.swift" }],
      importsClerkKit: [],
      importsClerkKitUI: [],
      configureCalls: [],
      localSecretsRuntimeBindings: [],
      environmentInjections: [],
      environmentConsumers: [],
      authFlowReferences: [],
      openURLHandlers: [],
      status: "absent",
    },
  };
}

function inspection(selected: IOSAppTarget): IOSProjectInspectionResult {
  return {
    schemaVersion: 1,
    platform: "ios",
    root: "/tmp/test",
    workspaces: [],
    projects: [],
    appTargets: [selected],
    selection: {
      state: "selected",
      targetId: selected.id,
      targetName: selected.name,
      projectPath: selected.projectPath,
    },
    localPublishableKey: {
      found: false,
      conflict: false,
      candidateSources: [],
      invalidSources: [],
    },
    generatedProject: null,
    diagnostics: [],
  };
}

describe("shouldInstallClerkKitUI", () => {
  test("defaults an untouched, fully inspected target to the prebuilt UI path", () => {
    expect(shouldInstallClerkKitUI(target())).toBe(true);
  });

  test("upgrades a source-blank ClerkKit-only graph created by an earlier setup", () => {
    const coreOnly = target();
    coreOnly.packages = { package: "remote", clerkKit: "linked", clerkKitUI: "absent" };
    expect(shouldInstallClerkKitUI(coreOnly)).toBe(true);
  });

  test("preserves a source-proven custom-flow target", () => {
    const customSource = target();
    customSource.swift.importsClerkKit = [{ path: "MyApp/Auth.swift" }];
    customSource.swift.status = "partial";
    expect(shouldInstallClerkKitUI(customSource)).toBe(false);
  });

  test("honors existing ClerkKitUI source or product evidence", () => {
    const imported = target();
    imported.swift.importsClerkKitUI = [{ path: "MyApp/Auth.swift" }];
    imported.swift.status = "partial";
    expect(shouldInstallClerkKitUI(imported)).toBe(true);

    const declared = target();
    declared.packages.clerkKitUI = "declared";
    expect(shouldInstallClerkKitUI(declared)).toBe(true);
  });

  test("does not infer a prebuilt default from incomplete source evidence", () => {
    const incomplete = target();
    incomplete.swift.evidenceComplete = false;
    incomplete.packages = { package: "remote", clerkKit: "linked", clerkKitUI: "absent" };
    expect(clerkKitUIInstallDecision(incomplete)).toBe("unknown");
    expect(shouldInstallClerkKitUI(incomplete)).toBe(false);

    incomplete.swift.importsClerkKit = [{ path: "MyApp/Visible.swift" }];
    expect(clerkKitUIInstallDecision(incomplete)).toBe("unknown");
    expect(shouldInstallClerkKitUI(incomplete)).toBe(false);
  });
});

describe("direct configuration compatibility", () => {
  test.each(["local-secrets-loader", "process-info-environment"] as const)(
    "preserves an existing %s configure route",
    (publishableKeyWiring) => {
      const selected = target();
      selected.swift.configureCalls = [
        {
          path: "MyApp/MyAppApp.swift",
          publishableKeyWiring,
          startupBinding: "app-init",
          ...(publishableKeyWiring === "local-secrets-loader"
            ? { localSecretsRuntimeBinding: "proven" as const }
            : {}),
        },
      ];
      const result = inspection(selected);

      expect(hasIOSDirectConfigCompatibility(result, selected)).toBe(true);
      expect(shouldPlanIOSDirectConfig(result, selected)).toBe(false);
    },
  );

  test("preserves an enabled selected-target scheme key route", () => {
    const selected = target();
    const result = inspection(selected);
    result.localPublishableKey.candidateSources = [
      "MyApp.xcodeproj/xcshareddata/xcschemes/MyApp.xcscheme",
    ];

    expect(hasIOSDirectConfigCompatibility(result, selected)).toBe(true);
    expect(shouldPlanIOSDirectConfig(result, selected)).toBe(false);
  });

  test("preserves a target-owned runtime key sink", () => {
    const selected = target();
    selected.runtimeKeySinks = [{ kind: "local-secrets-plist", path: "MyApp/LocalSecrets.plist" }];
    const result = inspection(selected);

    expect(hasIOSDirectConfigCompatibility(result, selected)).toBe(true);
    expect(shouldPlanIOSDirectConfig(result, selected)).toBe(false);
  });

  test("plans direct configuration for a fresh compatible target", () => {
    const selected = target();
    const result = inspection(selected);

    expect(hasIOSDirectConfigCompatibility(result, selected)).toBe(false);
    expect(shouldPlanIOSDirectConfig(result, selected)).toBe(true);
  });
});
