import type { resolveProfile } from "../../lib/config.ts";
import type { CliError } from "../../lib/errors.ts";
import type { Application } from "../../lib/plapi.ts";
import type { KeylessTarget } from "../../lib/keyless-target.ts";

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

/** The identity of an unclaimed keyless application, fetched via its own secret key. */
export interface KeylessInstanceInfo {
  id: string | null;
  environmentType: string | null;
}

export interface DoctorContext {
  /** PLAPI prefers this credential over any stored OAuth session. */
  hasPlatformAPIKey(): boolean;
  /** OAuth or Platform API-key presence; does not perform a network request. */
  hasAccountCredentials(): Promise<boolean>;
  /**
   * Read-only, memoized, account-scoped Platform API request used to verify
   * either the stored OAuth session or a configured Platform API key without
   * depending on this project's link state.
   */
  verifyAccountAccess(): Promise<void>;
  getToken(): Promise<string | null>;
  getValidToken(): Promise<string | null>;
  getProfile(): Promise<ResolvedProfile | undefined>;
  getApplication(): Promise<Application | null>;
  /**
   * Resolves the same keyless fallback the rest of the CLI uses (see
   * `lib/keyless-target.ts`), so doctor treats an unclaimed keyless project as
   * the legitimate state it is instead of failing the auth/link checks.
   */
  getKeylessTarget(): Promise<KeylessTarget | undefined>;
  /** Best-effort identity of the keyless instance, for naming it in check output. */
  getKeylessInstance(): Promise<KeylessInstanceInfo | null>;
  /**
   * The malformed-local-key error `getKeylessTarget()` swallowed, if any. A
   * key that doesn't start with `sk_` is precisely the misconfiguration doctor
   * exists to diagnose, so it surfaces as one named failing check instead of
   * crashing every keyless-aware check anonymously.
   */
  getKeylessKeyError(): Promise<CliError | undefined>;
  /**
   * Whether a `clerk init` claim breadcrumb is present, read once and without
   * side effects — `readKeylessBreadcrumb` clears a malformed file as it goes,
   * which a diagnostic command must not do, and two checks reading the disk
   * independently could otherwise print contradictory claim hints.
   */
  hasClaimBreadcrumb(): Promise<boolean>;
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
  /** Exact Xcode application target name or PBX object ID. */
  target?: string;
}
