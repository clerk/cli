import type {
  IOSAppTarget,
  IOSDiagnostic,
  IOSNativePlatform,
  IOSProjectInspection,
} from "./types.ts";

/** Internal result shared by the PBX and JSON Xcode-project readers. */
export interface ParsedIOSProject {
  inspection: IOSProjectInspection;
  appTargets: IOSAppTarget[];
  appTargetCandidates: Array<{
    targetId: string;
    targetName: string;
    projectPath: string;
    platform: IOSNativePlatform;
  }>;
  diagnostics: IOSDiagnostic[];
  sourceMemberships?: IOSTargetSourceMembership[];
}

export interface IOSTargetSourceMembership {
  targetId: string;
  targetName: string;
  projectPath: string;
  files: Array<{ absolutePath: string; relativePath: string }>;
  complete: boolean;
}
