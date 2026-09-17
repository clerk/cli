import { bold, cyan, dim, green, yellow } from "../../lib/color.ts";
import type { CnameTarget } from "../../lib/plapi.ts";
import { buildDashboardUrl } from "../../lib/environment.ts";

export type DeployPlanStep = {
  label: string;
  status: "done" | "pending";
};

export const DEPLOY_COMMAND_SUMMARY = "Deploy a Clerk application to production";

/**
 * Long description for `clerk deploy --help`. The wizard is registered as a
 * hidden default subcommand, so without this prose the help lists only
 * `status` and reads as if the CLI can only watch a deploy, not perform one.
 */
export const DEPLOY_COMMAND_DESCRIPTION = `${DEPLOY_COMMAND_SUMMARY}.

Running \`clerk deploy\` with no subcommand starts an interactive setup that
creates the production instance, prints the DNS records you must add, collects
production OAuth credentials, and verifies the domain. It needs a terminal;
re-run it at any time to resume where you left off.

When run by an agent (or without a TTY), it is read-only: it prints a JSON
status report with the current state and a \`nextAction\` field saying what to
do next. \`clerk deploy status\` prints the same report; add \`--wait\` to keep
checking until DNS, SSL, and email DNS are verified.`;

export const INTRO_PREAMBLE = `This will prepare your linked Clerk app for production by cloning your
development instance into a new production instance and walking you through
the setup the dashboard would otherwise guide you through.

Before you begin you will need:
  - A domain you own where you can add DNS records (example.com, or a
    subdomain like app.example.com). The URL a hosting provider generated
    for your deployment won't work here.
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
    `${yellow("NOTE")}  DNS records usually propagate within minutes, but can occasionally take up to 48 hours.`,
    `${dim(cyan("TIP"))}   If you can't add a CNAME for the Frontend API, you can use a proxy:`,
    dim("      https://clerk.com/docs/guides/dashboard/dns-domains/proxy-fapi"),
    dim("Reference: https://clerk.com/docs/guides/development/deployment/production#dns-records"),
  ];
}

export function clerkSubdomains(domain: string): {
  frontendApi: string;
  accountPortal: string;
  mail: string;
} {
  return {
    frontendApi: `clerk.${domain}`,
    accountPortal: `accounts.${domain}`,
    mail: `clkmail.${domain}`,
  };
}

/**
 * Every record host a new production domain needs, derived from the domain
 * alone so the confirmation screen can show the full list before the instance
 * exists. The DKIM selector is fixed server-side for domains the CLI creates
 * (`clk`, so `clk._domainkey` and `clk2._domainkey`); the real targets, with
 * their per-instance values, come back from the create call afterwards.
 */
export function productionDnsHosts(domain: string): string[] {
  const { frontendApi, accountPortal, mail } = clerkSubdomains(domain);
  return [
    frontendApi,
    accountPortal,
    mail,
    `clk._domainkey.${domain}`,
    `clk2._domainkey.${domain}`,
  ];
}

export function domainAssociationSummary(domain: string): string[] {
  const hosts = productionDnsHosts(domain);
  const labels = hosts.map((host) => cnameTargetLabel(host));
  const width = Math.max(...labels.map((label) => label.length));
  return [
    // Disclose the obligation before the one-way create step, without asking
    // for action the user can't take yet (record values arrive after creation).
    // "The exact list": the server omits the Account portal record when the
    // portal is disabled on the instance being cloned, and this screen runs
    // before the CLI can know that.
    `Clerk will use these subdomains for ${cyan(domain)}. You'll add DNS records for them after the instance is created. The exact list is printed once the instance exists:`,
    "",
    ...hosts.map((host, i) => `  ${labels[i]!.padEnd(width)}  ${host}`),
    "",
    "This will create a Clerk production instance for your application.",
  ];
}

/**
 * `afterCheck`: the records are being shown again because a DNS check didn't
 * find them. The user may already have added them and be waiting on
 * propagation, so the heading hedges. The first hand-over doesn't.
 */
export function dnsRecords(
  targets: readonly CnameTarget[],
  options: { afterCheck?: boolean } = {},
): string[] {
  const lines = [
    options.afterCheck
      ? "Add the following records at your DNS provider if you haven't already:"
      : "Add the following records at your DNS provider:",
  ];
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
    // These are CNAMEs pointing at Clerk, so the user never generates or
    // rotates key material and never hand-writes an SPF record. Said once
    // here rather than on each email row.
    "The email records point at Clerk, so you don't need to create SPF or DKIM values yourself.",
    "",
    `${yellow("NOTE")}  If your DNS host proxies these records, set them to "DNS only" or verification will fail.`,
  );
  return lines;
}

/**
 * The targets the user still has to add, given what the domain check found.
 * The single source of "are there records to show" for both the wizard and
 * the agent report; formatters and classifiers derive from this, never from
 * each other.
 */
export function pendingCnameTargets(
  targets: readonly CnameTarget[],
  status: DeployComponentStatus,
): CnameTarget[] {
  return targets.filter((target) => cnameTargetPending(target, status));
}

export function cnameTargetPending(target: CnameTarget, status: DeployComponentStatus): boolean {
  if (isMailCnameTarget(target)) return !status.mail;
  return !status.dns;
}

function isMailCnameTarget(target: CnameTarget): boolean {
  const prefix = target.host.split(".", 1)[0];
  return prefix === "clkmail" || prefix === "clk" || prefix === "clk2";
}

/**
 * Human label for a record host, used by every screen that lists records so
 * the confirmation screen and the records block can't name the same host two
 * ways. "DKIM" stays: it is the standard name for these records and already
 * appears in the host (`clk._domainkey`). What Clerk manages on the user's
 * behalf is said once under the block instead of on each row, where it read
 * as "nothing to do here".
 */
function cnameTargetLabel(host: string): string {
  // `host.split(".", 1)[0]` yields only the first label, so DKIM records
  // (clk._domainkey, clk2._domainkey) arrive here as "clk"/"clk2".
  const prefix = host.split(".", 1)[0];
  switch (prefix) {
    case "clerk":
      return "Frontend API";
    case "accounts":
      return "Account portal";
    case "clkmail":
      return "Email";
    case "clk":
    case "clk2":
      return "Email (DKIM)";
    default:
      return "CNAME";
  }
}

/**
 * `oauthNext` is required: on a fresh run with providers, OAuth setup comes
 * between this screen and the DNS check; on resume (OAuth already done) and
 * on a fresh run with no providers, the check is next. Saying "you'll set up
 * OAuth" under a checklist that shows OAuth done was wrong.
 */
export function dnsDashboardHandoff(
  domain: string,
  domainsUrl: string | undefined,
  options: { oauthNext: boolean },
): string[] {
  return [
    // "this command", not "the wizard": nothing the user sees uses that word.
    // Skipping the check leaves setup unfinished, so name what resumes it.
    `Monitor DNS propagation and SSL issuance for ${domain} on the Domains page in the Clerk Dashboard${domainsUrl ? ":" : "."}`,
    ...(domainsUrl ? [`  ${domainsUrl}`] : []),
    "",
    `${options.oauthNext ? "Next you'll set up OAuth, then this command checks these records." : "Next, this command checks these records."} If they haven't taken effect yet, you can skip the check and run \`clerk deploy\` again later to finish.`,
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
/**
 * What is actually outstanding after a domain check, from the user's point of
 * view. Records are theirs to add; SSL and final readiness are Clerk's side.
 * `records_unavailable` is the case where DNS is unverified but the API gave
 * us no record list to show — telling the user to "add the records" then
 * points at nothing. Shared by the wizard footer and the agent `nextAction`
 * so the two surfaces can't disagree.
 */
export type DomainPendingState =
  | "records_available"
  | "records_unavailable"
  | "ssl_pending"
  | "finalizing";

export function classifyDomainPending(
  status: DeployComponentStatus,
  hasPendingRecords: boolean,
): DomainPendingState {
  if (!status.dns || !status.mail) {
    return hasPendingRecords ? "records_available" : "records_unavailable";
  }
  if (!status.ssl) return "ssl_pending";
  return "finalizing";
}

/** "DNS", "email DNS", or "DNS and email DNS" — whichever records are unverified. */
export function pendingRecordComponents(status: DeployComponentStatus): string {
  const records: string[] = [];
  if (!status.dns) records.push("DNS");
  if (!status.mail) records.push("email DNS");
  return records.join(" and ");
}

export function deployStatusPendingFooter(
  domain: string,
  status: DeployComponentStatus,
  domainsUrl: string | undefined,
  hasPendingRecords: boolean,
): string[] {
  const state = classifyDomainPending(status, hasPendingRecords);
  const records = capitalizeFirst(pendingRecordComponents(status));

  // A lead line, then either a bulleted list (several follow-ups) or a blank
  // line and one sentence (a single follow-up). An empty string is a blank
  // line; the caller renders it with `log.blank()`.
  // The wizard is still running when this prints: a "Check again" prompt
  // follows, so the resume command is the fallback, not the instruction.
  const resume =
    "You can also skip for now and run `clerk deploy` later to resume; the production instance is already created.";
  if (state === "records_available") {
    return [
      `${records} records not found yet for ${domain}.`,
      `  - Add them at your DNS provider if you haven't already, then choose Check again below. ${resume}`,
      "  - Propagation usually takes minutes, but can occasionally take up to 48 hours.",
      `  - If you can't add DNS records for this domain, change the domain in the Clerk Dashboard${domainsUrl ? `: ${domainsUrl}` : "."}`,
    ];
  }
  if (state === "records_unavailable") {
    // URL on its own line: mid-sentence, terminal autolinkers swallow the
    // trailing punctuation.
    return [
      `${records} records not found yet for ${domain}.`,
      "",
      `Clerk didn't return the list of records to add. Find them on the Domains page in the Clerk Dashboard, add them, then choose Check again below. ${resume}`,
      ...(domainsUrl ? [`  ${domainsUrl}`] : []),
    ];
  }
  if (state === "ssl_pending") {
    return [
      `SSL certificate still pending for ${domain}.`,
      "",
      `Clerk issues it automatically now that DNS is verified; choose Check again below in a few minutes. ${resume}`,
    ];
  }
  return [
    `Production setup for ${domain} is still finalizing on Clerk's side.`,
    "",
    "Run `clerk deploy` again in a few minutes to resume. The production instance is already created.",
  ];
}

export const OAUTH_SECTION_INTRO = `${bold("Configure OAuth credentials for production")}

In development, Clerk provides shared OAuth credentials for most providers.
In production, those are not secure. You need your own credentials for
each enabled provider.

${dim("Reference: https://clerk.com/docs/guides/configure/auth-strategies/social-connections/overview")}`;

// `domainStatus` is required on both closing-screen functions: it selects the
// headline and step 3, and a caller that forgot it would print "Production
// ready" over a domain that doesn't resolve yet.
export function productionSummary(
  domain: string,
  completedOAuthProviderLabels: readonly string[],
  domainStatus: "verified" | "pending",
): string[] {
  return [
    domainStatus === "verified"
      ? `Production ready at ${cyan(`https://${domain}`)}`
      : `Production instance created for ${cyan(`https://${domain}`)}`,
    "",
    `  Domain      ${domainStatus === "verified" ? "Verified" : "DNS pending"}`,
    `  OAuth       ${completedOAuthProviderLabels.length ? completedOAuthProviderLabels.join(", ") : "Not applicable"}`,
  ];
}

export function nextStepsBody(
  appId: string,
  productionInstanceId: string,
  domain: string,
  domainStatus: "verified" | "pending",
): string {
  // Until DNS is verified the domain doesn't resolve, so "sign up there"
  // would send the user to a page that doesn't exist yet.
  const step3 =
    domainStatus === "verified"
      ? `Redeploy your app, then sign up at https://${domain} to confirm it works`
      : `Run \`clerk deploy\` again once your DNS records are added, then redeploy your app
     and sign up at https://${domain} to confirm it works`;
  return `
  1. Pull production keys into your environment
       clerk env pull --instance prod

     This writes pk_live_... and sk_live_... to your env file. They replace your
     pk_test_... and sk_test_... keys.

  2. Update env vars on your hosting provider
     Vercel, AWS, GCP, Heroku, Render, etc. all expose env vars in their UI.
       - Add the same pk_live_/sk_live_ values there.
       - Also copy the other Clerk variables from your env file, such as
         NEXT_PUBLIC_CLERK_SIGN_IN_URL. \`env pull\` writes only the two keys.

  3. ${step3}

  4. (If applicable) Update webhook URLs and signing secrets
     ${dim("https://clerk.com/docs/guides/development/webhooks/syncing#configure-your-production-instance")}

  5. (If applicable) Update your Content Security Policy
     ${dim("https://clerk.com/docs/guides/secure/best-practices/csp-headers")}

  6. Manage this instance in the Clerk Dashboard
       - Users, settings, and billing:
         ${dim(instanceDashboardUrl(appId, productionInstanceId))}
       - DNS and SSL status:
         ${dim(domainsDashboardUrl(appId, productionInstanceId))}

${yellow("NOTE")}  Production keys only work on your production domain. They will not work on localhost.
      To run your dev environment, keep using your dev keys.

${dim("Reference: https://clerk.com/docs/guides/development/deployment/production#api-keys-and-environment-variables")}`;
}

/**
 * Component labels are lowercase so they read naturally mid-sentence ("DNS
 * and email DNS"); when one of them opens a sentence it needs a capital.
 */
export function capitalizeFirst(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

/** Dashboard home for one instance: users, settings, billing. */
export function instanceDashboardUrl(appId: string, instanceId: string): string {
  return buildDashboardUrl(appId, instanceId);
}

export function domainsDashboardUrl(appId: string, productionInstanceId: string): string {
  return buildDashboardUrl(appId, productionInstanceId, "domains");
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
