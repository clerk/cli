import type { KnownDashboardPath } from "../open/dashboard-paths.ts";

export type Severity = "critical" | "recommended" | "good-to-have";

export type FindingStatus = "met" | "unmet" | "blocked";

export type InstanceConfig = Record<string, unknown>;

export type ConfigPatch = Record<string, unknown>;

export interface CheckInput {
  config: InstanceConfig;
  environmentType: string;
}

export interface CheckEvaluation {
  met: boolean;
  currentValue: unknown;
  recommendedValue: unknown;
  current: string;
  recommended: string;
}

export interface CheckDef {
  id: string;
  title: string;
  description: string;
  severity: Severity;
  path: string;
  dashboardPath: KnownDashboardPath;
  docsUrl: string;
  /** Billing feature the control needs on production. */
  feature?: string;
  /** False excludes the check from report and score. */
  appliesTo?(input: CheckInput): boolean;
  evaluate(input: CheckInput): CheckEvaluation;
  /** Prerequisite check id. Still scored while blocked. */
  blockedBy?: string;
  patch?(input: CheckInput): ConfigPatch;
  decision?: CheckDecision;
  manualRemedy?: string;
}

export type DecisionFlag = "factors" | "strategy";

export interface CheckDecision {
  flag: DecisionFlag;
  prompt: string;
  multiple: boolean;
  options: Array<{ value: string; label: string }>;
  defaults(input: CheckInput): string[];
  /** Usage error text for a choice the backend rejects. */
  validate?(values: string[], input: CheckInput): string | undefined;
  patch(values: string[], input: CheckInput): ConfigPatch;
}

export interface FindingDecision {
  flag: DecisionFlag;
  multiple: boolean;
  options: string[];
  suggested: string[];
}

export interface Finding extends CheckEvaluation {
  id: string;
  title: string;
  description: string;
  severity: Severity;
  status: FindingStatus;
  path: string;
  feature?: string;
  blockedBy?: string;
  patch: ConfigPatch | null;
  /** Patch the suggested decision values would produce. */
  suggestedPatch: ConfigPatch | null;
  decision?: FindingDecision;
  remedy: string;
  docsUrl: string;
  dashboardUrl: string;
}

export type SecurityGrade = "A" | "B" | "C" | "D" | "F";

export interface SecurityScore {
  grade: SecurityGrade;
  percent: number;
  met: number;
  total: number;
  hasCriticalGap: boolean;
}

export interface InstanceRef {
  appId: string;
  instanceId: string;
  environmentType: string;
  label: string;
}

export interface AuditReport {
  instance: InstanceRef;
  score: SecurityScore;
  /** Critical and recommended gaps only; null when none. */
  fixCommand: string | null;
  findings: Finding[];
}

export const FAIL_ON_LEVELS = ["critical", "recommended", "any", "none"] as const;
export type FailOnLevel = (typeof FAIL_ON_LEVELS)[number];

export interface AuditOptions {
  app?: string;
  instance?: string;
  json?: boolean;
  spotlight?: boolean;
  failOn?: FailOnLevel;
}

export interface FixOptions {
  app?: string;
  instance?: string;
  check?: string[];
  all?: boolean;
  dryRun?: boolean;
  yes?: boolean;
  json?: boolean;
  factors?: string[];
  strategy?: string;
  goodToHave?: boolean;
}

export type SkipReason = "met" | "not_applicable";

export interface FixSummary {
  /** False when nothing was sent. */
  changed: boolean;
  dryRun: boolean;
  applied: string[];
  decisions: Record<string, string[]>;
  skipped: Array<{ id: string; reason: SkipReason }>;
  score: { before: SecurityScore; after: SecurityScore };
  /** Projected under --dry-run. */
  remaining: string[];
}
