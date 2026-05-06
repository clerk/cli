import { bold, cyan, dim, yellow, red } from "../../lib/color.ts";
import { log } from "../../lib/log.ts";
import { openBrowser } from "../../lib/open.ts";

export type OAuthProvider = "google" | "github" | "microsoft" | "apple" | "linear";

export type OAuthField = {
  key: string;
  label: string;
  secret?: boolean;
  filePath?: boolean;
};

export const PROVIDER_LABELS: Record<OAuthProvider, string> = {
  google: "Google",
  github: "GitHub",
  microsoft: "Microsoft",
  apple: "Apple",
  linear: "Linear",
};

export const PROVIDER_FIELDS: Record<OAuthProvider, OAuthField[]> = {
  google: [
    { key: "client_id", label: "Client ID" },
    { key: "client_secret", label: "Client Secret", secret: true },
  ],
  github: [
    { key: "client_id", label: "Client ID" },
    { key: "client_secret", label: "Client Secret", secret: true },
  ],
  microsoft: [
    { key: "client_id", label: "Application (Client) ID" },
    { key: "client_secret", label: "Client Secret", secret: true },
  ],
  apple: [
    { key: "client_id", label: "Apple Services ID" },
    { key: "team_id", label: "Apple Team ID" },
    { key: "key_id", label: "Apple Key ID" },
    { key: "client_secret", label: "Apple Private Key - path to .p8 file", filePath: true },
  ],
  linear: [
    { key: "client_id", label: "Client ID" },
    { key: "client_secret", label: "Client Secret", secret: true },
  ],
};

export const PROVIDER_CREDENTIAL_LABELS: Record<OAuthProvider, string> = {
  google: "I already have my Client ID and Client Secret",
  github: "I already have my Client ID and Client Secret",
  microsoft: "I already have my Application (Client) ID and Client Secret",
  apple: "I already have my Services ID, Team ID, Key ID, and .p8 file",
  linear: "I already have my Client ID and Client Secret",
};

export const PROVIDER_REDIRECT_LABELS: Record<OAuthProvider, string> = {
  google: "Authorized Redirect URI",
  github: "Authorization Callback URL",
  microsoft: "Redirect URI",
  apple: "Return URL",
  linear: "Callback URL",
};

export const PROVIDER_DOC_URLS: Record<OAuthProvider, string> = {
  google: "https://clerk.com/docs/guides/configure/auth-strategies/social-connections/google",
  github: "https://clerk.com/docs/guides/configure/auth-strategies/social-connections/github",
  microsoft: "https://clerk.com/docs/guides/configure/auth-strategies/social-connections/microsoft",
  apple: "https://clerk.com/docs/guides/configure/auth-strategies/social-connections/apple",
  linear: "https://clerk.com/docs/guides/configure/auth-strategies/social-connections/linear",
};

export const PROVIDER_SETUP_COPY: Record<OAuthProvider, string> = {
  google: "Production Google sign-in requires custom OAuth credentials from Google Cloud Console.",
  github: "Production GitHub sign-in requires a GitHub OAuth app and custom credentials.",
  microsoft:
    "Production Microsoft sign-in requires a Microsoft Entra ID app and custom credentials.",
  apple:
    "Production Apple sign-in requires an Apple Services ID, Team ID, Key ID, and private key file.",
  linear: "Production Linear sign-in requires a Linear OAuth app and custom credentials.",
};

export const PROVIDER_GOTCHAS: Record<OAuthProvider, string | null> = {
  google: `${yellow("IMPORTANT")}  Set the OAuth consent screen's publishing status to "In production". Apps left in "Testing" are limited to 100 test users and may break for end users.`,
  github: null,
  microsoft: `${red("WARNING")}  Microsoft client secrets expire (default 6 months, max 24). Set a calendar reminder to rotate before expiration or sign-in will break.`,
  apple: `${yellow("IMPORTANT")}  Apple OAuth needs four artifacts: Apple Services ID, Apple Team ID, Apple Key ID, and Apple Private Key (.p8 file). The .p8 file cannot be re-downloaded - save it before leaving Apple's developer portal.`,
  linear: `${yellow("IMPORTANT")}  You must be a workspace admin in Linear to create OAuth apps.`,
};

export function providerLabel(provider: string): string {
  return PROVIDER_LABELS[provider as OAuthProvider] ?? provider;
}

export function providerSetupIntro(provider: OAuthProvider): string[] {
  const label = PROVIDER_LABELS[provider];
  return [
    bold(`Configure ${label} OAuth for production`),
    PROVIDER_SETUP_COPY[provider],
    dim(`Reference: ${PROVIDER_DOC_URLS[provider]}`),
  ];
}

export async function showOAuthWalkthrough(provider: OAuthProvider, domain: string): Promise<void> {
  const label = PROVIDER_LABELS[provider];
  const docsUrl = PROVIDER_DOC_URLS[provider];

  log.info(`\nConfigure your ${bold(label)} OAuth app with these values:\n`);
  log.info(`  ${dim("Authorized JavaScript origins")}`);
  log.info(`    ${cyan(`https://${domain}`)}`);
  log.info(`    ${cyan(`https://www.${domain}`)}`);
  log.info(`  ${dim(PROVIDER_REDIRECT_LABELS[provider])}`);
  log.info(`    ${cyan(`https://accounts.${domain}/v1/oauth_callback`)}`);
  const gotcha = PROVIDER_GOTCHAS[provider];
  if (gotcha) {
    log.blank();
    log.info(gotcha);
  }
  log.blank();
  log.info(dim(`Provider guide: ${docsUrl}`));

  const openResult = await openBrowser(docsUrl);
  if (!openResult.ok) {
    log.info(dim(`Open the setup guide: ${docsUrl}`));
  }
  log.blank();
}
