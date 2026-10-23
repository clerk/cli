import { CLERK_APP_WEB_APP_NOTE, type DeployComponentStatus } from "./copy.ts";

/**
 * How a production domain gets verified, resolved once from the domain's
 * `is_clerk_managed`. A domain you own waits on its DNS records; a clerk.app
 * domain has none and waits on its SSL certificate alone.
 */
export type DomainVerification = {
  readonly clerkManaged: boolean;
  readonly component: "dns" | "ssl";
  readonly subject: "DNS" | "SSL";
  readonly planLabel: string;
  /** Whether a run should ask Clerk to check the DNS records again. */
  readonly triggerDnsCheck: boolean;
  /** Appended to the "complete" next step. */
  readonly webAppNote: string;
  statusRow(status: DeployComponentStatus, mark: (ok: boolean) => string): string;
  signUpTarget(domain: string): string;
};

const OWN_DOMAIN: DomainVerification = {
  clerkManaged: false,
  component: "dns",
  subject: "DNS",
  planLabel: "Verify DNS records",
  triggerDnsCheck: true,
  webAppNote: "",
  statusRow: (status, mark) =>
    `DNS: ${mark(status.dns)}  SSL: ${mark(status.ssl)}  Email DNS: ${mark(status.mail)}`,
  signUpTarget: (domain) => `sign up at https://${domain}`,
};

const CLERK_APP: DomainVerification = {
  clerkManaged: true,
  component: "ssl",
  subject: "SSL",
  planLabel: "Issue SSL certificate",
  triggerDnsCheck: false,
  webAppNote: ` ${CLERK_APP_WEB_APP_NOTE}`,
  statusRow: (status, mark) => `SSL: ${mark(status.ssl)}`,
  signUpTarget: () => "sign up on your deployed app",
};

export function domainVerification(clerkManaged: boolean): DomainVerification {
  return clerkManaged ? CLERK_APP : OWN_DOMAIN;
}
