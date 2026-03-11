import type { resolveProfile } from "../../lib/config.ts";
import type { Application } from "../../lib/plapi.ts";

export type CheckStatus = "pass" | "warn" | "fail";

export type ResolvedProfile = NonNullable<Awaited<ReturnType<typeof resolveProfile>>>;

export interface FixAction {
  label: string;
  run: () => Promise<void>;
}

export interface CheckResult {
  name: string;
  status: CheckStatus;
  message: string;
  detail?: string;
  remedy?: string;
  fix?: FixAction;
}

export interface DoctorContext {
  getToken(): Promise<string | null>;
  getProfile(): Promise<ResolvedProfile | undefined>;
  getApplication(): Promise<Application | null>;
  fixes: {
    login: () => FixAction;
    link: () => FixAction;
    envPull: () => FixAction;
  };
}

export type CheckFn = (ctx: DoctorContext) => Promise<CheckResult>;

export interface DoctorOptions {
  verbose?: boolean;
  json?: boolean;
  spotlight?: boolean;
  fix?: boolean;
}
