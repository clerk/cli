import { isAgent } from "../../mode.ts";
import { CliError, ERROR_CODE, throwUsageError, throwUserAbort } from "../../lib/errors.ts";
import { log } from "../../lib/log.ts";
import { confirm } from "../../lib/prompts.ts";
import {
  createApplicationDomain,
  deleteApplicationDomain,
  type ApplicationDomain,
} from "../../lib/plapi.ts";
import { withSpinner } from "../../lib/spinner.ts";
import { parseClerkAppSlug } from "./clerk-app.ts";
import { dnsRecords, domainsDashboardUrl } from "./copy.ts";
import {
  isWebHostName,
  listDomains,
  PROVIDER_DOMAIN_SUFFIXES,
  sessionTokenIssuer,
  WEB_HOST_SUFFIXES,
} from "./domains.ts";
import { CLERK_APP_DOMAIN_EXISTS, CLERK_APP_SLUG_FORMAT, mapDeployError } from "./errors.ts";
import { DOMAIN_NAME } from "./prompts.ts";
import { resolveProductionApp } from "./status.ts";

const PROXY_PATH = "/__clerk";
const PROXY_DOCS_URL = "https://clerk.com/docs/guides/dashboard/dns-domains/proxy-fapi";

const ADD_NOT_ENABLED =
  "This application can't use clerk.app domains, so it can't add domains here. Manage its domains in the Clerk Dashboard.";

const CLERK_APP_NOT_AVAILABLE =
  "Free clerk.app domains aren't available right now. Nothing was added.";

const PROXY_INTRO =
  `Your app has to forward every request under ${PROXY_PATH} to Clerk. A plain rewrite isn't enough, ` +
  "because each request needs your secret key and the Clerk proxy headers.";

const PROXY_SETUP = [
  "Next.js, Express, Fastify and Hono: turn on frontendApiProxy in the Clerk middleware.",
  "Point your frontend at the proxy URL. In Next.js, set NEXT_PUBLIC_CLERK_PROXY_URL. Elsewhere, pass proxyUrl to ClerkProvider.",
  "Not using a Clerk SDK? Follow the proxy guide to set up the route yourself.",
  "A static site with no server can't run the proxy.",
  "Hosted sign-in pages don't work on a hosting domain. Add your own sign-in page with the <SignIn /> component and set signInUrl to it. " +
    "In Next.js, set NEXT_PUBLIC_CLERK_SIGN_IN_URL.",
];

const PASSKEYS_NOTE =
  "Passkeys don't work on hosting domains yet. Passkeys in your native apps aren't affected.";

function hostingNotes(name: string, issuer: string): string[] {
  return [
    `Your app on ${name} uses the same Clerk setup as your primary domain.`,
    "A route you add to your app passes sign-in requests to Clerk, so users, sign-in options and emails are all shared.",
    `If your backend checks the session token's issuer, also accept ${issuer}.`,
    PASSKEYS_NOTE,
  ];
}

/**
 * PLAPI routes a name by itself: on an instance with a clerk.app domain, a
 * hosting provider's URL becomes a hosting domain served through the Clerk
 * proxy, and any other name becomes the instance's one custom domain. A
 * `<slug>.clerk.app` name becomes the instance's one clerk.app domain on any
 * production instance.
 */
export type AddDomainReport =
  | {
      domain: string;
      kind: "clerk_app";
      added: boolean;
      primary: boolean;
      nextAction: string;
    }
  | {
      domain: string;
      kind: "hosting";
      added: boolean;
      proxyUrl: string;
      proxySetup: string[];
      notes: string[];
      docsUrl: string;
      nextAction: string;
    }
  | {
      domain: string;
      kind: "custom";
      added: boolean;
      primary: boolean;
      dnsRecords: { type: "CNAME"; host: string; value: string; required: boolean }[];
      nextAction: string;
    };

function parseDomainName(raw: string): string {
  const name = raw
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/\/+$/, "");
  if (!DOMAIN_NAME.test(name)) {
    throwUsageError("Enter the domain as a host name, such as example.com or acme.netlify.app.");
  }
  return name;
}

function isClerkAppName(name: string): boolean {
  return name.endsWith(".clerk.app");
}

function refuseUnaddableName(name: string): void {
  if (isClerkAppName(name)) {
    if (!parseClerkAppSlug(name).ok) {
      throwUsageError(
        `${CLERK_APP_SLUG_FORMAT} Nothing was added.`,
        undefined,
        ERROR_CODE.CLERK_APP_SLUG_INVALID,
      );
    }
    return;
  }
  if (!isWebHostName(name) && PROVIDER_DOMAIN_SUFFIXES.some((suffix) => name.endsWith(suffix))) {
    throwUsageError(unsupportedHosting(name), undefined, ERROR_CODE.KNOWN_HOSTING_DOMAIN);
  }
}

function unsupportedHosting(name: string): string {
  return (
    `${name} is on a hosting provider Clerk doesn't support yet. Nothing was added. ` +
    `Use a domain you own, or a URL on one of: ${WEB_HOST_SUFFIXES.join(", ")}.`
  );
}

/** PLAPI accepts one domain you own beside clerk.app, primary or not. */
function secondOwnDomain(own: ApplicationDomain): string {
  return own.is_primary
    ? `Production already uses ${own.name}, and it can have only one domain you own beside clerk.app. Nothing was added.`
    : `You already added ${own.name}, and production can have only one domain you own beside clerk.app. Nothing was added. ` +
        `Run \`clerk deploy use-domain ${own.name}\`, or remove it with \`clerk deploy remove-domain ${own.name}\` first.`;
}

export async function addDomain(rawDomain: string): Promise<void> {
  const name = parseDomainName(rawDomain);
  refuseUnaddableName(name);
  const { appId, productionInstanceId } = await resolveProductionApp("add-domain");
  const domains = await listDomains(appId);

  const existing = domains.find((d) => d.name.toLowerCase() === name);
  if (existing?.is_satellite) {
    throwUsageError(
      `${name} is a satellite domain of this application. Nothing was added.`,
      undefined,
      ERROR_CODE.DEPLOY_DOMAIN_CONFLICT,
    );
  }
  if (existing) {
    emitAddDomainReport(buildAddDomainReport(existing, false));
    return;
  }

  const clerkAppName = isClerkAppName(name);
  const clerkApp = domains.find((d) => d.is_clerk_managed);
  if (clerkAppName && clerkApp) {
    throw new CliError(CLERK_APP_DOMAIN_EXISTS, { code: ERROR_CODE.CLERK_APP_DOMAIN_EXISTS });
  }
  if (!clerkAppName && !clerkApp) {
    const primary = domains.find((d) => d.is_primary);
    throw new CliError(
      `\`clerk deploy add-domain\` adds domains to an app on clerk.app, and production uses ${primary?.name ?? "another domain"} with no clerk.app domain. ` +
        `Nothing was added. Manage its domains in the Clerk Dashboard: ${domainsDashboardUrl(appId, productionInstanceId)}`,
      { code: ERROR_CODE.NO_CLERK_APP_DOMAIN },
    );
  }

  const own = domains.find((d) => !d.is_satellite && !d.is_web_host && !d.is_clerk_managed);
  const domain = await withSpinner(`Adding ${name}...`, async () =>
    mapDeployError(
      createApplicationDomain(appId, { name }),
      clerkAppName
        ? {
            featureNotEnabledMessage: CLERK_APP_NOT_AVAILABLE,
            slugUnavailableMessage: "This name is taken. Nothing was added.",
            instanceTypeInvalidMessage:
              "Only production instances can add a clerk.app domain. Nothing was added.",
          }
        : {
            featureNotEnabledMessage: ADD_NOT_ENABLED,
            knownHostingDomainMessage: unsupportedHosting(name),
            customDomainExistsMessage: own && secondOwnDomain(own),
          },
    ),
  );
  emitAddDomainReport(buildAddDomainReport(domain, true));
}

/** Undefined when production doesn't list `name` as a hosting domain. */
export async function readHostingDomainReport(
  appId: string,
  name: string,
  added: boolean,
): Promise<AddDomainReport | undefined> {
  const hosting = (await listDomains(appId)).find(
    (d) => d.is_web_host && d.name.toLowerCase() === name,
  );
  return hosting && buildAddDomainReport(hosting, added);
}

function buildAddDomainReport(domain: ApplicationDomain, added: boolean): AddDomainReport {
  const { name } = domain;
  const primary = Boolean(domain.is_primary);
  if (domain.is_clerk_managed) {
    return {
      domain: name,
      kind: "clerk_app",
      added,
      primary,
      nextAction: primary
        ? `${name} is already production's primary domain. Nothing changed.`
        : `Make ${name} primary with \`clerk deploy use-domain ${name}\` once it's ready.`,
    };
  }
  if (domain.is_web_host) {
    const proxyUrl = domain.proxy_url ?? `https://${name}${PROXY_PATH}`;
    return {
      domain: name,
      kind: "hosting",
      added,
      proxyUrl,
      proxySetup: PROXY_SETUP,
      notes: hostingNotes(name, sessionTokenIssuer(domain) ?? proxyUrl),
      docsUrl: PROXY_DOCS_URL,
      nextAction: `Serve the Clerk proxy at ${proxyUrl}, then redeploy your app. ${PROXY_INTRO}`,
    };
  }
  return {
    domain: name,
    kind: "custom",
    added,
    primary,
    dnsRecords: primary
      ? []
      : (domain.cname_targets ?? []).map((target) => ({
          type: "CNAME" as const,
          host: target.host,
          value: target.value,
          required: target.required,
        })),
    nextAction: primary
      ? `${name} is already production's primary domain. Nothing changed.`
      : `Add the DNS records for ${name} at your DNS provider. Clerk checks them on its own. ` +
        `Make ${name} primary once it's configured with \`clerk deploy use-domain ${name}\`. ` +
        "It says which of DNS, SSL and email DNS are still pending, and switches once they all pass." +
        (domain.frontend_api_url
          ? ` If you use your own OAuth credentials, add ${domain.frontend_api_url}/v1/oauth_callback ` +
            "to each provider's app now, next to the redirect URL it has. Keep both, so sign-in works before and after the switch."
          : ""),
  };
}

export function emitAddDomainReport(report: AddDomainReport): void {
  if (isAgent()) {
    log.data(JSON.stringify(report, null, 2));
    return;
  }
  log.blank();
  if (report.kind === "hosting") {
    if (report.added) {
      log.success(
        `${report.domain} is on a hosting provider, so it's added as a hosting domain. It can't be made primary.`,
      );
    } else {
      log.info(`${report.domain} is already one of your domains`);
    }
    log.blank();
    log.info(`  Proxy URL:  ${report.proxyUrl}`);
    log.blank();
    log.info(PROXY_INTRO);
    for (const step of report.proxySetup) log.info(`  • ${step}`);
    log.blank();
    for (const note of report.notes) log.info(note);
    log.info(`Proxy guide: ${report.docsUrl}`);
    log.blank();
    return;
  }
  if (report.added) log.success(`Added ${report.domain}`);
  else log.info(`${report.domain} is already one of your domains`);
  if (report.kind === "clerk_app") {
    if (!report.primary) {
      log.blank();
      log.info(
        "No DNS records to add. Your app keeps using its current domain until you make this one primary.",
      );
    }
  } else if (report.dnsRecords.length > 0) {
    log.blank();
    for (const line of dnsRecords(report.dnsRecords)) log.info(line);
  }
  log.blank();
  log.info(report.nextAction);
  log.blank();
}

type DomainKind = "clerk_app" | "hosting" | "satellite" | "custom";

const KIND_LABELS: Record<DomainKind, string> = {
  clerk_app: "Clerk-managed",
  hosting: "Hosting",
  satellite: "Satellite",
  custom: "Custom",
};

function domainKind(domain: ApplicationDomain): DomainKind {
  if (domain.is_clerk_managed) return "clerk_app";
  if (domain.is_web_host) return "hosting";
  if (domain.is_satellite) return "satellite";
  return "custom";
}

type DomainSummary = {
  domain: string;
  kind: DomainKind;
  primary: boolean;
  proxyUrl: string | null;
};

export async function listDomainsCommand(): Promise<void> {
  const { appId } = await resolveProductionApp("domains");
  const domains: DomainSummary[] = (await listDomains(appId)).map((d) => ({
    domain: d.name,
    kind: domainKind(d),
    primary: Boolean(d.is_primary),
    proxyUrl: d.proxy_url ?? null,
  }));

  if (isAgent()) {
    log.data(JSON.stringify({ domains }, null, 2));
    return;
  }
  const width = Math.max(...domains.map((d) => d.domain.length));
  const kindWidth = Math.max(...domains.map((d) => KIND_LABELS[d.kind].length));
  log.info("Domains");
  for (const d of domains) {
    const columns = [
      d.domain.padEnd(width),
      KIND_LABELS[d.kind].padEnd(kindWidth),
      d.primary ? "Primary" : "",
    ];
    log.info(`  ${columns.join("   ").trimEnd()}`);
  }
}

type RemoveDomainReport = { domain: string; removed: boolean };

/**
 * Removing a domain that is already gone reports `removed: false` and
 * succeeds, so a rerun converges. Deleting the primary would make PLAPI
 * promote another domain, and deleting the clerk.app domain is its permanent
 * shutdown, which the Dashboard owns.
 */
export async function removeDomain(
  rawDomain: string,
  options: { yes?: boolean } = {},
): Promise<void> {
  const name = parseDomainName(rawDomain);
  const { appId, productionInstanceId } = await resolveProductionApp("remove-domain");
  const found = (await listDomains(appId)).find((d) => d.name.toLowerCase() === name);

  if (found?.is_primary) {
    throw new CliError(
      `${name} is production's primary domain, so it can't be removed. Nothing changed. ` +
        "Make another domain primary first with `clerk deploy use-domain <domain>`.",
      { code: ERROR_CODE.DOMAIN_NOT_REMOVABLE },
    );
  }
  if (found?.is_clerk_managed) {
    throw new CliError(
      `${name} is this application's clerk.app domain. Shutting it down is permanent, so do it in the Clerk Dashboard. ` +
        `Nothing changed. ${domainsDashboardUrl(appId, productionInstanceId)}`,
      { code: ERROR_CODE.DOMAIN_NOT_REMOVABLE },
    );
  }
  if (found && !options.yes) {
    if (isAgent()) {
      throwUsageError(
        `\`clerk deploy remove-domain\` stops Clerk serving ${name} and needs consent. Pass --yes to confirm.`,
        undefined,
        undefined,
        [
          {
            command: `clerk deploy remove-domain ${name} --yes`,
            description: `Remove ${name}`,
          },
        ],
      );
    }
    const proceed = await confirm({
      message: `Remove ${name}? Clerk stops serving it, so sign-in there stops working.`,
      default: false,
    });
    if (!proceed) throwUserAbort();
  }
  if (found) {
    await withSpinner(`Removing ${name}...`, async () =>
      mapDeployError(deleteApplicationDomain(appId, found.id)),
    );
  }

  const report: RemoveDomainReport = { domain: name, removed: Boolean(found) };
  if (isAgent()) {
    log.data(JSON.stringify(report, null, 2));
  } else if (report.removed) {
    log.success(`Removed ${name}`);
  } else {
    log.info(`${name} isn't one of this application's domains. Nothing to remove.`);
  }
}
