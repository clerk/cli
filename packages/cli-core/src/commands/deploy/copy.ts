import { cyan, dim, green, red, yellow } from "../../lib/color.ts";
import type { CnameTarget } from "./api.ts";

export const INTRO_PREAMBLE = `This will prepare your linked Clerk app for production by cloning your
development instance into a new production instance and walking you through
the setup the dashboard would otherwise guide you through.

Before you begin you will need:
  - A domain you own (production cannot use a development subdomain).
  - The ability to add DNS records on that domain.
  - OAuth credentials for any social providers you have enabled in dev.

${dim("Reference: https://clerk.com/docs/guides/development/deployment/production")}`;

export function printPlan(appLabel: string, oauthProviderLabels: readonly string[]): string[] {
  return [
    `clerk deploy will prepare ${cyan(appLabel)} for production:`,
    "",
    `  ${green("CREATE")}  Create production instance`,
    `  ${green("DOMAIN")}  Choose a production domain you own`,
    `  ${green("DNS")}     Configure DNS records`,
    ...oauthProviderLabels.map(
      (label) => `  ${yellow("OAUTH")}   Configure ${label} OAuth credentials`,
    ),
  ];
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
    "You can continue to the remaining setup now, or pause and run `clerk deploy --continue` later.",
  ];
}

export function dnsVerified(domain: string): string[] {
  return [`DNS verified for ${domain}.`];
}

export const OAUTH_SECTION_INTRO = `Configure OAuth credentials for production

In development, Clerk provides shared OAuth credentials for most providers.
In production, those are not secure. You need your own credentials for
each enabled provider.

${dim("Reference: https://clerk.com/docs/guides/configure/auth-strategies/social-connections/overview")}`;

export function productionSummary(
  domain: string,
  completedOAuthProviderLabels: readonly string[],
): string[] {
  return [
    `Production ready at ${cyan(`https://${domain}`)}`,
    "",
    "  Domain      Verified",
    `  OAuth       ${completedOAuthProviderLabels.length ? completedOAuthProviderLabels.join(", ") : "Not applicable"}`,
  ];
}

export const NEXT_STEPS_BLOCK = `Next steps

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

${yellow("NOTE")}  Production keys only work on your production domain. They will not work on localhost.
      To run your dev environment, keep using your dev keys.

${dim("Reference: https://clerk.com/docs/guides/development/deployment/production#api-keys-and-environment-variables")}`;

export function pausedMessage(stepDescription: string): string {
  return `Deploy paused at: ${stepDescription}

${pausedOperationNotice()}`;
}

export function activeDeployInProgressMessage(stepDescription: string): string {
  return `There is an active deploy in progress at: ${stepDescription}

Use \`clerk deploy --continue\` to resume it, or \`clerk deploy --abort\` to clear it.`;
}

export function pausedOperationNotice(): string {
  return `Deploy paused.

Use \`clerk deploy --continue\` to resume it, or \`clerk deploy --abort\` to clear it.`;
}

export const INVALID_CONTINUE_MESSAGE = `${red("The paused deploy operation no longer matches this linked project.")}
Run \`clerk deploy\` from the project that started the paused operation, or run
\`clerk link\` if you intend to deploy this one.`;
