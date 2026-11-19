import { PROD_FAPI_URL } from "@clerk/shared/constants";
import { isAgent } from "../../mode.ts";
import {
  CliError,
  ERROR_CODE,
  EXIT_CODE,
  throwUsageError,
  throwUserAbort,
} from "../../lib/errors.ts";
import { log } from "../../lib/log.ts";
import { confirm } from "../../lib/prompts.ts";
import {
  makeApplicationDomainPrimary,
  type ApplicationDomain,
  type MakePrimaryReadiness,
} from "../../lib/plapi.ts";
import { withSpinner } from "../../lib/spinner.ts";
import { declareSoftExitOutcome } from "../../lib/telemetry.ts";
import { clerkAppDomain, parseClerkAppSlug } from "./clerk-app.ts";
import { dnsRecords, domainsDashboardUrl, pendingCnameTargets } from "./copy.ts";
import { domainVerification } from "./domain-verification.ts";
import { listDomains, sessionTokenIssuer } from "./domains.ts";
import { mapDeployError, READINESS_LABELS } from "./errors.ts";
import { validateDomain } from "./prompts.ts";
import { resolveProductionApp, triggerDeployStatusCheck } from "./status.ts";

const SWITCH_NOT_ENABLED =
  "Switching the primary domain isn't available for this application yet. Use the Clerk Dashboard instead.";

/**
 * `clerkApp` is the application's clerk.app domain when the target is another
 * domain, and `hasHostingDomains` says whether hosting domains still use it.
 * `current` is the primary domain a ready switch moves away from.
 */
export type UseDomainPlan =
  | {
      kind: "already_primary";
      domain: ApplicationDomain;
      clerkApp?: ApplicationDomain;
      hasHostingDomains: boolean;
    }
  | { kind: "not_ready"; domain: ApplicationDomain; readiness: MakePrimaryReadiness }
  | {
      kind: "ready";
      domain: ApplicationDomain;
      current?: ApplicationDomain;
      clerkApp?: ApplicationDomain;
      hasHostingDomains: boolean;
    };

function refuseSwitch(): never {
  throw new CliError(SWITCH_NOT_ENABLED, { code: ERROR_CODE.CLERK_APP_NOT_ENABLED });
}

/**
 * PLAPI lists readiness on every non-satellite domain of an application that
 * may switch its primary domain, and on none otherwise.
 *
 * PLAPI switches only away from a clerk.app domain, and a clerk.app domain
 * can't become primary again. Anything else is refused here, before a request
 * changes production. Adding the domain is `add-domain`'s job.
 */
export function planUseDomain(
  domains: readonly ApplicationDomain[],
  name: string,
  domainsUrl: string,
): UseDomainPlan {
  const named = domains.find((candidate) => candidate.name.toLowerCase() === name);
  if (named?.is_satellite) {
    throwUsageError(
      `${name} is a satellite domain of this application, so it can't be the primary domain. ` +
        "Remove it as a satellite in the Clerk Dashboard first, or choose another domain.",
      undefined,
      ERROR_CODE.DEPLOY_DOMAIN_CONFLICT,
    );
  }
  const candidates = domains.filter((candidate) => !candidate.is_satellite);
  const clerkApp = candidates.find(
    (candidate) => candidate.is_clerk_managed && candidate !== named,
  );
  const hasHostingDomains = domains.some((candidate) => candidate.is_web_host);
  if (named?.is_primary) {
    return { kind: "already_primary", domain: named, clerkApp, hasHostingDomains };
  }
  if (named?.is_web_host) {
    throwUsageError(
      `${name} is a hosting domain served through the Clerk proxy. ` +
        "It can't be the primary domain. Run `clerk deploy use-domain <domain>` with a domain you own instead.",
      undefined,
      ERROR_CODE.WEB_HOST_CANNOT_BE_PRIMARY,
    );
  }

  if (named?.is_clerk_managed || name.endsWith(".clerk.app")) {
    throwUsageError(
      `${name} is a clerk.app domain, and a clerk.app domain can't become the primary domain again. ` +
        "Nothing changed. Run `clerk deploy use-domain <domain>` with a domain you own instead.",
      undefined,
      ERROR_CODE.DEPLOY_DOMAIN_CONFLICT,
    );
  }

  const primary = domains.find((candidate) => candidate.is_primary);
  if (!primary?.is_clerk_managed) {
    throw new CliError(
      "`clerk deploy use-domain` moves production off its clerk.app domain, " +
        `and production uses ${primary?.name ?? "another domain"}. Nothing changed. ` +
        `Change the primary domain in the Clerk Dashboard instead: ${domainsUrl}`,
      { code: ERROR_CODE.PRIMARY_NOT_CLERK_MANAGED },
    );
  }
  if (!candidates.some((candidate) => candidate.make_primary_readiness)) refuseSwitch();

  if (!named) {
    throw new CliError(
      `${name} isn't one of this application's domains yet. Nothing changed. ` +
        `Add it with \`clerk deploy add-domain ${name}\`, then run this command again.`,
      { code: ERROR_CODE.DOMAIN_NOT_FOUND },
    );
  }
  const readiness = named.make_primary_readiness ?? refuseSwitch();
  if (readiness.dns && readiness.ssl && readiness.email) {
    return { kind: "ready", domain: named, current: primary, clerkApp, hasHostingDomains };
  }
  return { kind: "not_ready", domain: named, readiness };
}

export type UseDomainReport = {
  domain: string;
  primary: boolean;
  readiness: MakePrimaryReadiness | null;
  pendingDnsRecords: { type: "CNAME"; host: string; value: string; required: boolean }[];
  nextAction: string;
};

export async function useDomain(rawDomain: string, options: { yes?: boolean } = {}): Promise<void> {
  const name = parseDomainArgument(rawDomain);

  const { appId, productionInstanceId } = await resolveProductionApp("use-domain");
  const domainsUrl = domainsDashboardUrl(appId, productionInstanceId);

  const plan = await recheckDomain(appId, name, domainsUrl);

  let report: UseDomainReport;
  if (plan.kind === "ready" && !options.yes && isAgent()) {
    report = buildConsentReport(name, plan);
  } else {
    if (plan.kind === "ready") {
      const note = issuerSwitchNote(name, plan);
      if (note) log.info(note);
      const oauthNote = oauthCallbackNote(plan);
      if (oauthNote) log.info(oauthNote);
      if (!options.yes) {
        const proceed = await confirm({
          message: `Make ${name} the primary domain?`,
          default: true,
        });
        if (!proceed) throwUserAbort();
      }
      await withSpinner(`Making ${name} the primary domain...`, async () =>
        mapDeployError(makeApplicationDomainPrimary(appId, plan.domain.id), {
          featureNotEnabledMessage: SWITCH_NOT_ENABLED,
        }),
      );
    }
    report = buildUseDomainReport(name, plan, domainsUrl);
  }

  emitReport(report);
  if (!report.primary) {
    process.exitCode = EXIT_CODE.GENERAL;
    declareSoftExitOutcome("incomplete");
  }
}

function parseDomainArgument(raw: string): string {
  const name = raw.trim().toLowerCase();
  if (name.endsWith(".clerk.app")) {
    const parsed = parseClerkAppSlug(name);
    if (!parsed.ok) throwUsageError(parsed.message, undefined, ERROR_CODE.CLERK_APP_SLUG_INVALID);
    return clerkAppDomain(parsed.slug);
  }
  const valid = validateDomain(name);
  if (valid !== true) throwUsageError(valid);
  return name;
}

/**
 * Readiness comes from the domain's last DNS check. A domain that isn't ready
 * gets a new check, which the next run reads.
 */
async function recheckDomain(
  appId: string,
  name: string,
  domainsUrl: string,
): Promise<UseDomainPlan> {
  const plan = planUseDomain(await listDomains(appId), name, domainsUrl);
  if (plan.kind === "not_ready") await triggerDeployStatusCheck(appId, plan.domain.id);
  return plan;
}

/**
 * Apps already shipped keep sending the old issuer after the switch, so a
 * backend that checks it has to accept both before the switch.
 */
function issuerSwitchNote(
  name: string,
  plan: Extract<UseDomainPlan, { kind: "ready" }>,
): string | undefined {
  const next = sessionTokenIssuer(plan.domain);
  const previous = plan.current && sessionTokenIssuer(plan.current);
  if (!next || !previous || next === previous) return undefined;
  return (
    `Session tokens from apps on ${name} use the issuer ${next}. ` +
    `If your backend checks the issuer, accept it as well as ${previous} before you switch, ` +
    "because app versions you already shipped keep sending the old one."
  );
}

/**
 * Each sign-in sends the redirect URL of the domain it started on, and builds
 * with the old key keep signing in on the old domain, so a provider app with
 * your own OAuth credentials needs both URLs.
 */
function oauthCallbackNote(plan: Extract<UseDomainPlan, { kind: "ready" }>): string | undefined {
  const next = plan.domain.frontend_api_url;
  const previous = plan.current?.frontend_api_url;
  if (!next || !previous || next === previous) return undefined;
  return (
    "If you use your own OAuth credentials, each provider's app needs both redirect URLs: " +
    `${previous}/v1/oauth_callback and ${next}/v1/oauth_callback. Add the new one before you switch.`
  );
}

function buildConsentReport(
  name: string,
  plan: Extract<UseDomainPlan, { kind: "ready" }>,
): UseDomainReport {
  const issuerNote = issuerSwitchNote(name, plan);
  const oauthNote = oauthCallbackNote(plan);
  return {
    domain: name,
    primary: false,
    readiness: plan.domain.make_primary_readiness ?? null,
    pendingDnsRecords: [],
    nextAction:
      `${name} is ready to be the primary domain. Switching changes the domain users sign in on ` +
      "and the publishable key, and users must create their passkeys again. " +
      (issuerNote ? `${issuerNote} ` : "") +
      (oauthNote ? `${oauthNote} ` : "") +
      `Once the user agrees, run \`clerk deploy use-domain ${name} --yes\`.`,
  };
}

export function buildUseDomainReport(
  name: string,
  plan: UseDomainPlan,
  domainsUrl: string,
): UseDomainReport {
  if (plan.kind === "already_primary" || plan.kind === "ready") {
    const switched = plan.kind === "ready";
    const hostingWarning =
      plan.hasHostingDomains && plan.clerkApp
        ? " Your hosting domains keep working after the shutdown. Before it, redeploy the apps on them with the new keys, " +
          `and point any proxy you wrote yourself at ${PROD_FAPI_URL} instead of ${plan.clerkApp.frontend_api_url}.`
        : "";
    const shutDown = plan.clerkApp
      ? ` ${plan.clerkApp.name} keeps working for builds that still use it. ` +
        `Once none do, you can shut it down in the Clerk Dashboard: ${domainsUrl}.${hostingWarning}`
      : "";
    return {
      domain: name,
      primary: true,
      readiness: plan.domain.make_primary_readiness ?? null,
      pendingDnsRecords: [],
      nextAction:
        `${name} is ${switched ? "now" : "already"} the primary domain. ` +
        "Run `clerk env pull --instance prod` to get the production keys for it, then redeploy your app." +
        shutDown,
    };
  }

  const { readiness } = plan;
  const pending = pendingCnameTargets(plan.domain.cname_targets ?? [], {
    dns: readiness.dns,
    ssl: readiness.ssl,
    mail: readiness.email,
  });
  const missing = (["dns", "ssl", "email"] as const)
    .filter((check) => !readiness[check])
    .map((check) => READINESS_LABELS[check]);
  const addRecords =
    pending.length > 0 ? "Add the DNS records listed for it at your DNS provider. " : "";
  return {
    domain: name,
    primary: false,
    readiness,
    pendingDnsRecords: pending.map((target) => ({
      type: "CNAME" as const,
      host: target.host,
      value: target.value,
      required: target.required,
    })),
    nextAction:
      `${name} isn't ready to be the primary domain yet. Still pending: ${missing.join(", ")}. ` +
      `${addRecords}Clerk is checking it again. Run \`clerk deploy use-domain ${name}\` in a few minutes to check again; ` +
      "it doesn't switch without confirmation. " +
      `Propagation usually takes minutes. Domain status is also on the Clerk Dashboard: ${domainsUrl}`,
  };
}

function emitReport(report: UseDomainReport): void {
  if (isAgent()) {
    log.data(JSON.stringify(report, null, 2));
    return;
  }
  log.blank();
  if (report.readiness && !report.primary) {
    const { dns, ssl, email } = report.readiness;
    const row = domainVerification(false).statusRow({ dns, ssl, mail: email }, (ok) =>
      ok ? "complete" : "pending",
    );
    log.info(`  ${report.domain}   ${row}`);
  }
  if (report.pendingDnsRecords.length > 0) {
    log.blank();
    for (const line of dnsRecords(report.pendingDnsRecords)) log.info(line);
  }
  log.blank();
  if (report.primary) log.success(report.nextAction);
  else log.info(report.nextAction);
  log.blank();
}
