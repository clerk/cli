/**
 * The doctor module's shared contract: the result and context types every
 * check is written against, and — the one runtime export — the display name
 * of each check, which both the checks and the registry in `index.ts` read.
 */
import type { resolveProfile } from "../../lib/config.ts";
import type { CliError } from "../../lib/errors.ts";
import type { Application } from "../../lib/plapi.ts";
import type { KeylessTarget } from "../../lib/keyless-target.ts";

/**
 * The display name of every check, in one place.
 *
 * A check that throws never returns a result, so `runChecks` has to name it
 * from outside — and a second list of names would drift from these the first
 * time one was reworded. This is that one list, read by the checks and by the
 * registry in `index.ts`. Declaration order here is not read; the registry
 * lists the checks in the order they run.
 */
export const CHECK_NAME = {
  cliVersion: "CLI version",
  hostExecution: "Host execution",
  loggedIn: "Logged in",
  tokenValid: "Authentication valid",
  projectLinked: "Project linked",
  linkedAppExists: "Application reachable",
  instances: "Instance IDs",
  envVars: "Environment variables",
  configFile: "CLI configuration",
  shellCompletion: "Shell completion",
  mcp: "MCP server",
} as const;

export type CheckKey = keyof typeof CHECK_NAME;

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
  /**
   * The check threw, so it learned nothing about what it verifies. Set
   * explicitly by the only place that catches — never inferred later from the
   * message text, which would make a sentence nobody knew was load-bearing
   * into the contract.
   */
  crashed?: true;
}

/** The identity of an unclaimed keyless application, fetched via its own secret key. */
export interface KeylessInstanceInfo {
  id: string | null;
  environmentType: string | null;
}

export interface DoctorContext {
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
}
