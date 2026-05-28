import { bold, cyan, dim, green, yellow } from "../../lib/color.ts";
import type { CnameTarget } from "../../lib/plapi.ts";

export type DeployPlanStep = {
  label: string;
  status: "done" | "pending";
};

export const INTRO_PREAMBLE = `This will prepare your linked Clerk app for production by cloning your
development instance into a new production instance and walking you through
the setup the dashboard would otherwise guide you through.

Before you begin you will need:
  - A domain you own (production cannot use a development subdomain).
  - The ability to add DNS records on that domain.
  - OAuth credentials for any social providers you have enabled in dev.

${dim("Reference: https://clerk.com/docs/guides/development/deployment/production")}`;

export function printPlan(appLabel: string, steps: readonly DeployPlanStep[]): string[] {
  return [
    `clerk deploy will prepare ${cyan(appLabel)} for production:`,
    "",
    ...steps.map((step) => `  ${planStatus(step.status)} ${step.label}`),
  ];
}

function planStatus(status: DeployPlanStep["status"]): string {
  if (status === "done") return green("[x]");
  return yellow("[ ]");
}

export function dnsIntro(domain: string): string[] {
  return [
    `Configure DNS for ${cyan(domain)}`,
    "",
    "Clerk uses DNS records to provide session management and emails",
    "verified from your domain.",
    "",
    `${yellow("NOTE")}  It can take up to 48 hours for DNS records to fully propagate.`,
    `${dim(cyan("TIP"))}   If you can't add a CNAME for the Frontend API, you can use a proxy:`,
    dim("      https://clerk.com/docs/guides/dashboard/dns-domains/proxy-fapi"),
    dim("Reference: https://clerk.com/docs/guides/development/deployment/production#dns-records"),
  ];
}

export function domainAssociationSummary(domain: string): string[] {
  const hosts = [`clerk.${domain}`, `accounts.${domain}`, `clkmail.${domain}`];
  return [
    `Clerk will associate these subdomains with ${cyan(domain)}:`,
    "",
    ...hosts.map((host) => `  ${cnameTargetLabel(host)}  ${host}`),
    "",
    "This will create a Clerk production instance for your application.",
  ];
}

export function dnsRecords(targets: readonly CnameTarget[]): string[] {
  const lines = ["Add the following records at your DNS provider:"];
  for (const target of targets) {
    const label = cnameTargetLabel(target.host);
    const optional = target.required ? "" : ` ${dim("(optional)")}`;
    lines.push(
      "",
      `  ${label}${optional}`,
      `    Type:  CNAME`,
      `    Host:  ${target.host}`,
      `    Value: ${target.value}`,
    );
  }
  lines.push(
    "",
    `${yellow("NOTE")}  If your DNS host proxies these records, set them to "DNS only" or verification will fail.`,
  );
  return lines;
}

export function pendingDnsRecords(
  targets: readonly CnameTarget[],
  status: DeployComponentStatus,
): string[] {
  const pendingTargets = targets.filter((target) => cnameTargetPending(target, status));
  if (pendingTargets.length === 0) return [];
  return dnsRecords(pendingTargets);
}

export function cnameTargetPending(target: CnameTarget, status: DeployComponentStatus): boolean {
  if (isMailCnameTarget(target)) return !status.mail;
  return !status.dns;
}

function isMailCnameTarget(target: CnameTarget): boolean {
  const prefix = target.host.split(".", 1)[0];
  return prefix === "clkmail" || prefix === "clk" || prefix === "clk2";
}

function cnameTargetLabel(host: string): string {
  const prefix = host.split(".", 1)[0];
  switch (prefix) {
    case "clerk":
      return "Frontend API";
    case "accounts":
      return "Account portal";
    case "clkmail":
    case "clk._domainkey":
    case "clk2._domainkey":
      return "Email (Clerk handles SPF/DKIM automatically)";
    default:
      return "CNAME";
  }
}

export function dnsDashboardHandoff(domain: string): string[] {
  return [
    `Check the Domains section in the Clerk Dashboard for ${domain} to monitor DNS propagation and SSL issuance.`,
    "After OAuth setup, you can verify DNS or skip and finish. DNS propagation can take time.",
  ];
}

export function dnsVerified(domain: string): string[] {
  return [`DNS verified for ${domain}.`];
}

export type DeployComponentStatus = {
  dns: boolean;
  ssl: boolean;
  mail: boolean;
};

export type DeployComponent = "mail" | "dns" | "ssl";

export function deployComponentLabels(
  component: DeployComponent,
  domain: string,
): { progress: string; done: string } {
  switch (component) {
    case "mail":
      return {
        progress: `Verifying email DNS records for ${domain}...`,
        done: "Email DNS records verified",
      };
    case "dns":
      return {
        progress: `Verifying DNS records for ${domain}...`,
        done: `DNS verified for ${domain}.`,
      };
    case "ssl":
      return {
        progress: `Issuing SSL certificate for ${domain}...`,
        done: `SSL certificate issued for ${domain}`,
      };
  }
}

/**
 * Status line for the domain checks Clerk verifies after the production
 * instance is created: DNS propagation, SSL issuance via Let's Encrypt, and
 * email DNS records. Each value comes from the same domain status response.
 */
export function deployComponentStatus(status: DeployComponentStatus): string {
  const mark = (ok: boolean) => (ok ? green("✓") : yellow("pending"));
  return `DNS: ${mark(status.dns)}  SSL: ${mark(status.ssl)}  Email DNS: ${mark(status.mail)}`;
}

export function deployStatusRetryMessage(
  message: string,
  currentRetry: number,
  totalRetries: number,
  seconds: number,
): string {
  return `${message} ${currentRetry}/${totalRetries} attempts, retrying in ${seconds}s`;
}

/**
 * Footer printed when domain status polling times out before all three
 * components are complete. The user keeps the deploy state; rerunning
 * `clerk deploy` resumes from whichever component is still pending.
 */
export function deployStatusPendingFooter(domain: string, status: DeployComponentStatus): string[] {
  const pending: string[] = [];
  if (!status.dns) pending.push("DNS");
  if (!status.ssl) pending.push("SSL");
  if (!status.mail) pending.push("email DNS");

  const lead =
    pending.length === 0
      ? `Production setup for ${domain} is still finalizing.`
      : `${pending.join(", ")} still pending for ${domain}.`;

  return [
    lead,
    "DNS propagation can take several hours depending on your provider.",
    "Run `clerk deploy` again to resume. The production instance is already created.",
  ];
}

export const OAUTH_SECTION_INTRO = `${bold("Configure OAuth credentials for production")}

In development, Clerk provides shared OAuth credentials for most providers.
In production, those are not secure. You need your own credentials for
each enabled provider.

${dim("Reference: https://clerk.com/docs/guides/configure/auth-strategies/social-connections/overview")}`;

export function productionSummary(
  domain: string,
  completedOAuthProviderLabels: readonly string[],
  domainStatus: "verified" | "pending" = "verified",
): string[] {
  return [
    `Production ready at ${cyan(`https://${domain}`)}`,
    "",
    `  Domain      ${domainStatus === "verified" ? "Verified" : "DNS pending"}`,
    `  OAuth       ${completedOAuthProviderLabels.length ? completedOAuthProviderLabels.join(", ") : "Not applicable"}`,
  ];
}

export function nextStepsBlock(appId: string, productionInstanceId: string): string {
  return `${bold("Next steps")}

  1. Pull production keys into your environment
       clerk env pull --instance prod

     This writes pk_live_... and sk_live_... to your .env. They replace your
     pk_test_... and sk_test_... keys.

  2. Update env vars on your hosting provider
     Vercel, AWS, GCP, Heroku, Render, etc. all expose env vars in their UI.
     Add the same pk_live_/sk_live_ values there.

  3. Redeploy your app

  4. (If applicable) Update webhook URLs and signing secrets
     ${dim("https://clerk.com/docs/guides/development/webhooks/syncing#configure-your-production-instance")}

  5. (If applicable) Update your Content Security Policy
     ${dim("https://clerk.com/docs/guides/secure/best-practices/csp-headers")}

  6. View and manage domain configuration in the Clerk Dashboard
     ${dim(`https://dashboard.clerk.com/apps/${appId}/instances/${productionInstanceId}/domains`)}

${yellow("NOTE")}  Production keys only work on your production domain. They will not work on localhost.
      To run your dev environment, keep using your dev keys.

${dim("Reference: https://clerk.com/docs/guides/development/deployment/production#api-keys-and-environment-variables")}`;
}

export function pausedMessage(stepDescription: string): string {
  return `Deploy paused at: ${stepDescription}

${pausedOperationNotice()}`;
}

export function pausedOperationNotice(): string {
  return `Deploy paused.

Run \`clerk deploy\` again to continue from the current API state.`;
}

function ensureTrailingDot(value: string): string {
  return value.endsWith(".") ? value : `${value}.`;
}

export function bindZoneFile(domain: string, targets: readonly CnameTarget[], now: Date): string {
  const lines = [
    `; Generated by \`clerk deploy\` on ${now.toISOString()}`,
    `; Import into your existing zone for ${domain} to add Clerk's required DNS records.`,
    `$ORIGIN ${ensureTrailingDot(domain)}`,
    `$TTL 300`,
    ``,
  ];
  for (const target of targets) {
    lines.push(`${ensureTrailingDot(target.host)}\tIN\tCNAME\t${ensureTrailingDot(target.value)}`);
  }
  return `${lines.join("\n")}\n`;
}
