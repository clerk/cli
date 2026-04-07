import type { Root, Need, DepsRegistry } from "../../lib/deps.ts";
import type { Application } from "../../lib/plapi.ts";

export type CheckStatus = "pass" | "warn" | "fail";

/**
 * Non-undefined branch of `configStore.resolveProfile`'s return type. Derived
 * from the registry so a config schema change is caught at compile time here.
 */
export type ResolvedProfile = NonNullable<
  Awaited<ReturnType<DepsRegistry["configStore"]["resolveProfile"]>>
>;

/**
 * Pattern B fix action: takes the full Root so it can dispatch to any
 * ported command (login/link/pullDefault/etc.) with that command's slice.
 */
export interface FixAction {
  label: string;
  run: (root: Root) => Promise<void>;
}

export interface CheckResult {
  name: string;
  status: CheckStatus;
  message: string;
  detail?: string;
  remedy?: string;
  fix?: FixAction;
}

/**
 * Cached, lazily-evaluated state shared across checks. The doctor command
 * builds one of these per run so multiple checks reuse the same token /
 * profile / application lookups instead of duplicating I/O.
 */
export interface DoctorContext {
  getToken(): Promise<string | null>;
  getProfile(): Promise<ResolvedProfile | undefined>;
  getApplication(): Promise<Application | null>;
}

/**
 * Doctor's slice. Doctor is unusual: it accepts the full `Root` because its
 * fix handlers are dynamic (selected at runtime based on which check failed)
 * and each fix dispatches to a different ported command, so a narrow slice
 * cannot cover the cross-command call surface up front. Type-aliasing `Root`
 * here keeps the call signature consistent with the rest of the DI'd
 * commands while making it explicit that doctor is intentionally broad.
 */
export type DoctorDeps = Root;

/**
 * Slice for the individual check helpers. Lists every collaborator method
 * the check functions transitively touch. Fix handlers are excluded — they
 * receive the full Root via `FixAction.run` instead.
 */
export type CheckDeps = Need<{
  credentialStore: "getToken";
  configStore: "resolveProfile";
  plapi: "fetchApplication";
  tokenExchange: "fetchUserInfo";
  env: "get";
}>;

export type CheckFn = (deps: CheckDeps, ctx: DoctorContext) => Promise<CheckResult>;

export interface DoctorOptions {
  verbose?: boolean;
  json?: boolean;
  spotlight?: boolean;
  fix?: boolean;
}
