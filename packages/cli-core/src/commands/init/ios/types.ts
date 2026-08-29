export type IOSDiagnosticSeverity = "info" | "warning" | "error";

export interface IOSSourceEvidence {
  /** Project-root-relative path. */
  path: string;
  objectId?: string;
  keyPath?: string;
}

export interface IOSDiagnostic {
  code:
    | "xcode.no-project"
    | "xcode.malformed-project"
    | "xcode.missing-project-file"
    | "xcode.dangling-reference"
    | "xcode.no-ios-app-target"
    | "xcode.ambiguous-app-target"
    | "xcode.target-not-found"
    | "xcode.unresolved-build-setting"
    | "xcode.conflicting-build-setting"
    | "xcode.missing-entitlements"
    | "xcode.unreadable-entitlements"
    | "xcode.invalid-apple-entitlement"
    | "xcode.external-path"
    | "xcode.generated-project"
    | "xcode.incomplete-source-membership"
    | "xcode.interrupted-file-transaction"
    | "clerk.package-unattributed"
    | "clerk.invalid-publishable-key";
  severity: IOSDiagnosticSeverity;
  message: string;
  remedy?: string;
  evidence: IOSSourceEvidence[];
}

export type IOSValueResolution =
  | { state: "resolved"; value: string; evidence: IOSSourceEvidence[] }
  | {
      state: "unresolved";
      raw: string;
      missingVariables: string[];
      evidence: IOSSourceEvidence[];
    }
  | { state: "missing"; evidence: IOSSourceEvidence[] };

export type IOSAppleEntitlementState = "absent" | "exact" | "invalid";

export interface IOSEntitlementsInspection {
  path: string;
  associatedDomains: string[];
  unresolvedAssociatedDomains: string[];
  applicationIdentifier?: string;
  /** Literal prefix candidate from the source plist, validated against the Bundle ID. */
  literalAppIdentifierPrefix?: string;
  teamIdentifier?: string;
  /** Whether the entitlement is absent, the exact supported value, or malformed. */
  signInWithAppleState: IOSAppleEntitlementState;
  /** True only for the exact supported one-element `Default` array. */
  signInWithApple: boolean;
}

export interface IOSBuildConfiguration {
  name: string;
  bundleIdentifier: IOSValueResolution;
  developmentTeam: IOSValueResolution;
  entitlementsPath: IOSValueResolution;
  deploymentTarget: IOSValueResolution;
  entitlements?: IOSEntitlementsInspection;
}

export type IOSPackageReference =
  | {
      kind: "remote";
      objectId: string;
      repository: string;
      requirement?: Record<string, string>;
      isClerk: boolean;
    }
  | {
      kind: "local";
      objectId: string;
      path: string;
      isClerk: boolean;
    };

export type IOSProductLinkState = "linked" | "declared" | "absent";

export interface IOSClerkPackageState {
  package: "remote" | "local" | "unattributed" | "absent";
  clerkKit: IOSProductLinkState;
  clerkKitUI: IOSProductLinkState;
}

export type IOSPublishableKeyWiring = "inline-literal" | "custom";

export type IOSInlinePublishableKeyInspection =
  | {
      state: "valid";
      frontendApiHost: string;
      instanceType: "development" | "production";
    }
  | { state: "invalid" };

export interface IOSConfigureCallEvidence extends IOSSourceEvidence {
  /** Redacted classification only; the key expression and value are never retained. */
  publishableKeyWiring: IOSPublishableKeyWiring;
  /** Decoded metadata for a plain inline literal. The literal itself is never retained. */
  inlinePublishableKey?: IOSInlinePublishableKeyInspection;
  /** Whether this call is a direct statement in the selected @main type's init(). */
  startupBinding: "app-init" | "unproven";
}

export interface IOSSwiftInspection {
  sourceFilesScanned: number;
  /** False when target membership was truncated or a member could not be read. */
  evidenceComplete: boolean;
  entryPoints: IOSSourceEvidence[];
  importsClerkKit: IOSSourceEvidence[];
  importsClerkKitUI: IOSSourceEvidence[];
  configureCalls: IOSConfigureCallEvidence[];
  environmentInjections: IOSSourceEvidence[];
  environmentConsumers: IOSSourceEvidence[];
  authFlowReferences: IOSSourceEvidence[];
  openURLHandlers: IOSSourceEvidence[];
  status: "complete" | "partial" | "absent" | "ambiguous";
}

export interface IOSAppTarget {
  id: string;
  name: string;
  productName?: string;
  projectPath: string;
  configurations: IOSBuildConfiguration[];
  packages: IOSClerkPackageState;
  swift: IOSSwiftInspection;
}

export interface IOSProjectInspection {
  path: string;
  pbxprojPath: string;
  objectVersion?: string;
  packages: IOSPackageReference[];
  appTargetIds: string[];
  diagnostics: IOSDiagnostic[];
}

export interface IOSWorkspaceInspection {
  path: string;
  projectPaths: string[];
}

export type IOSTargetSelection =
  | { state: "selected"; targetId: string; targetName: string; projectPath: string }
  | {
      state: "ambiguous";
      candidates: Array<{ targetId: string; targetName: string; projectPath: string }>;
    }
  | { state: "not-found"; requested: string; candidates: string[] }
  | { state: "none" };

export type IOSLocalPublishableKeyInspection =
  | {
      state: "valid";
      source: string;
      frontendApiHost: string;
      instanceType: "development" | "production";
    }
  | { state: "invalid"; source: string }
  | { state: "unproven" }
  | { state: "missing" };

export interface IOSProjectInspectionResult {
  schemaVersion: 1;
  platform: "ios";
  /** Absolute invocation root. Paths nested below it are emitted relatively. */
  root: string;
  workspaces: IOSWorkspaceInspection[];
  projects: IOSProjectInspection[];
  appTargets: IOSAppTarget[];
  selection: IOSTargetSelection;
  localPublishableKey: IOSLocalPublishableKeyInspection;
  generatedProject: "xcodegen" | "tuist" | null;
  diagnostics: IOSDiagnostic[];
}

export type IOSSetupStepId =
  | "select-target"
  | "install-clerk-sdk"
  | "configure-publishable-key"
  | "inject-clerk-environment"
  | "wire-auth-callbacks"
  | "register-native-application"
  | "enable-native-apple"
  | "add-associated-domain"
  | "add-authentication-flow"
  | "verify-integration";

export type IOSSetupStepStatus = "satisfied" | "required" | "review" | "blocked";

export interface IOSSetupStep {
  id: IOSSetupStepId;
  title: string;
  status: IOSSetupStepStatus;
  automatable: boolean;
  description: string;
  links?: Array<{ kind: "dashboard" | "documentation"; url: string }>;
  evidence: IOSSourceEvidence[];
}

export interface IOSSetupPlan {
  schemaVersion: 1;
  kind: "clerk-ios-setup";
  root: string;
  status: "ready" | "action-required" | "blocked";
  selection: IOSTargetSelection;
  summary: Record<IOSSetupStepStatus, number>;
  steps: IOSSetupStep[];
  diagnostics: IOSDiagnostic[];
}
