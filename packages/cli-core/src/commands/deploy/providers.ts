import { OAUTH_PROVIDERS } from "@clerk/shared/oauth";
import { bold, cyan, dim, yellow } from "../../lib/color.ts";
import { log } from "../../lib/log.ts";
import { openBrowser } from "../../lib/open.ts";
import type { ConfigSchemaProperty, InstanceConfigSchema } from "../../lib/plapi.ts";

const DEFAULT_DOCS_URL_PREFIX =
  "https://clerk.com/docs/guides/configure/auth-strategies/social-connections";

/**
 * OAuth provider slug used by deploy.
 */
export type OAuthProvider = string;

/**
 * Existing prompt field shape consumed by the current deploy flow.
 */
export type OAuthField = {
  key: string;
  label: string;
  secret?: boolean;
  filePath?: boolean;
};

/**
 * Prompt field metadata derived from the production config schema.
 */
export type OAuthPromptField = {
  key: string;
  label: string;
  description?: string;
  type: "text" | "password" | "select";
  options?: string[];
  defaultValue?: string;
  secret: boolean;
  filePath: boolean;
};

/**
 * Complete deploy metadata for configuring an OAuth provider.
 */
export type OAuthProviderDescriptor = {
  provider: string;
  configKey: string;
  label: string;
  docsUrl: string;
  credentialLabel: string;
  redirectLabel: string;
  setupCopy: string;
  gotcha: string | null;
  fields: OAuthPromptField[];
  requiredCredentialKeys: string[];
  credentialSources: Array<"manual" | "google-json">;
};

/**
 * Descriptor builder output split by deploy support status.
 */
export type OAuthProviderDescriptorResult = {
  supported: OAuthProviderDescriptor[];
  unsupported: string[];
};

type ProviderOverride = {
  credentialLabel?: string;
  redirectLabel?: string;
  setupCopy?: string;
  gotcha?: string | null;
  credentialSources?: Array<"manual" | "google-json">;
  fieldOrder?: string[];
  fieldLabels?: Record<string, string>;
  filePathFields?: string[];
  omittedFields?: string[];
  requiredCredentialKeys?: string[];
};

const PROVIDER_OVERRIDES = {
  google: {
    credentialLabel: "I already have my Client ID and Client Secret",
    redirectLabel: "Authorized Redirect URI",
    setupCopy:
      "Production Google sign-in requires custom OAuth credentials from Google Cloud Console.",
    gotcha: `${yellow("IMPORTANT")}  Set the OAuth consent screen's publishing status to "In production". Apps left in "Testing" are limited to 100 test users and may break for end users.`,
    credentialSources: ["manual", "google-json"],
  },
  apple: {
    credentialLabel: "I already have my Services ID, Team ID, Key ID, and .p8 file",
    redirectLabel: "Return URL",
    setupCopy:
      "Production Apple sign-in requires an Apple Services ID, Team ID, Key ID, and private key file.",
    gotcha: `${yellow("IMPORTANT")}  Apple OAuth needs four artifacts: Apple Services ID, Apple Team ID, Apple Key ID, and Apple Private Key (.p8 file). The .p8 file cannot be re-downloaded - save it before leaving Apple's developer portal.`,
    fieldOrder: ["client_id", "team_id", "key_id", "client_secret"],
    fieldLabels: {
      client_id: "Apple Services ID",
      team_id: "Apple Team ID",
      key_id: "Apple Key ID",
      client_secret: "Apple Private Key - path to .p8 file",
    },
    filePathFields: ["client_secret"],
    omittedFields: ["bundle_id"],
    requiredCredentialKeys: ["client_id", "team_id", "key_id", "client_secret"],
  },
} satisfies Record<string, ProviderOverride>;

type ProviderWithOverride = keyof typeof PROVIDER_OVERRIDES;

const SYSTEM_FIELD_KEYS = new Set(["enabled", "authenticatable", "block_email_subaddresses"]);
const DEFAULT_FIELD_ORDER = ["client_id", "client_secret"];
export const OAUTH_KEY_PREFIX = "connection_oauth_";

const SHARED_OAUTH_METADATA = new Map<string, (typeof OAUTH_PROVIDERS)[number]>(
  OAUTH_PROVIDERS.map((provider) => [provider.provider, provider]),
);

const COMPATIBLE_PROVIDER_DESCRIPTORS = buildCompatibilityDescriptors();

/**
 * Compatibility labels for the deploy flow that still consumes provider maps.
 */
export const PROVIDER_LABELS: Record<ProviderWithOverride, string> = Object.fromEntries(
  COMPATIBLE_PROVIDER_DESCRIPTORS.map((descriptor) => [descriptor.provider, descriptor.label]),
) as Record<ProviderWithOverride, string>;

/**
 * Compatibility fields for the deploy flow that still consumes provider maps.
 */
export const PROVIDER_FIELDS: Record<ProviderWithOverride, OAuthField[]> = Object.fromEntries(
  COMPATIBLE_PROVIDER_DESCRIPTORS.map((descriptor) => [
    descriptor.provider,
    descriptor.fields.map((field) => ({
      key: field.key,
      label: field.label,
      secret: field.secret || undefined,
      filePath: field.filePath || undefined,
    })),
  ]),
) as Record<ProviderWithOverride, OAuthField[]>;

/**
 * Compatibility credential action labels for the current prompt flow.
 */
export const PROVIDER_CREDENTIAL_LABELS: Record<ProviderWithOverride, string> = Object.fromEntries(
  COMPATIBLE_PROVIDER_DESCRIPTORS.map((descriptor) => [
    descriptor.provider,
    descriptor.credentialLabel,
  ]),
) as Record<ProviderWithOverride, string>;

/**
 * Compatibility redirect labels for the current walkthrough flow.
 */
export const PROVIDER_REDIRECT_LABELS: Record<ProviderWithOverride, string> = Object.fromEntries(
  COMPATIBLE_PROVIDER_DESCRIPTORS.map((descriptor) => [
    descriptor.provider,
    descriptor.redirectLabel,
  ]),
) as Record<ProviderWithOverride, string>;

/**
 * Compatibility setup copy for the current walkthrough flow.
 */
export const PROVIDER_SETUP_COPY: Record<ProviderWithOverride, string> = Object.fromEntries(
  COMPATIBLE_PROVIDER_DESCRIPTORS.map((descriptor) => [descriptor.provider, descriptor.setupCopy]),
) as Record<ProviderWithOverride, string>;

/**
 * Compatibility gotchas for the current walkthrough flow.
 */
export const PROVIDER_GOTCHAS: Record<ProviderWithOverride, string | null> = Object.fromEntries(
  COMPATIBLE_PROVIDER_DESCRIPTORS.map((descriptor) => [descriptor.provider, descriptor.gotcha]),
) as Record<ProviderWithOverride, string | null>;

/**
 * Build deploy OAuth provider descriptors from the instance config schema.
 */
export function buildOAuthProviderDescriptors(
  providers: readonly string[],
  schema: InstanceConfigSchema,
): OAuthProviderDescriptorResult {
  const supported: OAuthProviderDescriptor[] = [];
  const unsupported: string[] = [];

  for (const provider of providers) {
    const descriptor = buildOAuthProviderDescriptor(provider, schema);
    if (!descriptor) {
      unsupported.push(provider);
      continue;
    }

    supported.push(descriptor);
  }

  return { supported, unsupported };
}

/**
 * Determine whether production config already contains every credential
 * required by a schema-derived provider descriptor.
 */
export function hasProviderRequiredCredentials(
  config: Record<string, unknown>,
  descriptor: OAuthProviderDescriptor,
): boolean {
  const value = config[descriptor.configKey];
  if (!value || typeof value !== "object") return false;
  const providerConfig = value as Record<string, unknown>;
  if (providerConfig.enabled !== true) return false;
  return descriptor.requiredCredentialKeys.every((key) => {
    const fieldValue = providerConfig[key];
    return typeof fieldValue === "string" && fieldValue.length > 0;
  });
}

function buildOAuthProviderDescriptor(
  provider: string,
  schema: InstanceConfigSchema,
): OAuthProviderDescriptor | null {
  const configKey = `${OAUTH_KEY_PREFIX}${provider}`;
  const configSchema = schema.properties?.[configKey];
  if (configSchema?.type !== "object" || !configSchema.properties) return null;

  const override = providerOverride(provider) ?? {};
  const omittedFields = new Set(override.omittedFields ?? []);
  const requiredFieldKeys = new Set(override.requiredCredentialKeys ?? DEFAULT_FIELD_ORDER);
  const fields: OAuthPromptField[] = [];

  for (const [key, property] of Object.entries(configSchema.properties)) {
    if (SYSTEM_FIELD_KEYS.has(key) || omittedFields.has(key) || property.readOnly) continue;

    const field = buildPromptField(key, property, override);
    if (!field) {
      if (requiredFieldKeys.has(key)) return null;
      continue;
    }
    fields.push(field);
  }

  fields.sort((a, b) => compareFields(a.key, b.key, override.fieldOrder));

  const fieldKeys = new Set(fields.map((field) => field.key));
  const requiredCredentialKeys =
    override.requiredCredentialKeys ?? defaultRequiredCredentialKeys(fieldKeys);
  if (requiredCredentialKeys.length === 0) return null;
  if (requiredCredentialKeys.some((key) => !fieldKeys.has(key))) return null;

  const label = providerLabel(provider);
  return {
    provider,
    configKey,
    label,
    docsUrl: providerDocsUrl(provider),
    credentialLabel:
      override.credentialLabel ??
      `I already have my ${credentialListLabel(requiredCredentialKeys)}`,
    redirectLabel: override.redirectLabel ?? "Redirect URI",
    setupCopy:
      override.setupCopy ?? `Production ${label} sign-in requires custom OAuth credentials.`,
    gotcha: override.gotcha ?? null,
    fields,
    requiredCredentialKeys,
    credentialSources: override.credentialSources ?? ["manual"],
  };
}

function buildPromptField(
  key: string,
  property: ConfigSchemaProperty,
  override: ProviderOverride,
): OAuthPromptField | null {
  if (property.type !== "string") return null;

  const stringEnum =
    property.enum?.every((value) => typeof value === "string") === true ? property.enum : undefined;
  if (property.enum && !stringEnum) return null;

  const secret = property["x-clerk-sensitive"] === true;
  return {
    key,
    label: override.fieldLabels?.[key] ?? fieldLabel(key),
    description: property.description,
    type: stringEnum ? "select" : secret ? "password" : "text",
    options: stringEnum,
    defaultValue: typeof property.default === "string" ? property.default : undefined,
    secret,
    filePath: override.filePathFields?.includes(key) === true,
  };
}

function providerOverride(provider: string): ProviderOverride | undefined {
  return (PROVIDER_OVERRIDES as Record<string, ProviderOverride | undefined>)[provider];
}

function compareFields(a: string, b: string, overrideOrder: string[] | undefined): number {
  const order = overrideOrder ?? DEFAULT_FIELD_ORDER;
  const aIndex = order.indexOf(a);
  const bIndex = order.indexOf(b);
  if (aIndex !== -1 || bIndex !== -1) {
    if (aIndex === -1) return 1;
    if (bIndex === -1) return -1;
    return aIndex - bIndex;
  }
  return a.localeCompare(b);
}

function defaultRequiredCredentialKeys(fieldKeys: Set<string>): string[] {
  return DEFAULT_FIELD_ORDER.filter((key) => fieldKeys.has(key));
}

function providerDocsUrl(provider: string): string {
  return (
    SHARED_OAUTH_METADATA.get(provider)?.docsUrl ??
    `${DEFAULT_DOCS_URL_PREFIX}/${provider.replaceAll("_", "-")}`
  );
}

function fieldLabel(key: string): string {
  if (key === "client_id") return "Client ID";
  return key
    .split("_")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function credentialListLabel(requiredCredentialKeys: readonly string[]): string {
  const labels = requiredCredentialKeys.map(fieldLabel);
  if (labels.length === 1) return labels[0] ?? "";
  if (labels.length === 2) return `${labels[0]} and ${labels[1]}`;
  return `${labels.slice(0, -1).join(", ")}, and ${labels.at(-1)}`;
}

function buildCompatibilityDescriptors(): OAuthProviderDescriptor[] {
  const schemas = Object.fromEntries(
    Object.keys(PROVIDER_OVERRIDES).map((provider) => [
      `${OAUTH_KEY_PREFIX}${provider}`,
      {
        type: "object",
        properties: compatibilityProviderProperties(provider),
      },
    ]),
  );

  return buildOAuthProviderDescriptors(Object.keys(PROVIDER_OVERRIDES), {
    type: "object",
    properties: schemas,
  }).supported;
}

function compatibilityProviderProperties(provider: string): Record<string, ConfigSchemaProperty> {
  const override = providerOverride(provider);
  const keys = override?.requiredCredentialKeys ?? DEFAULT_FIELD_ORDER;
  return Object.fromEntries(
    keys.map((key) => [
      key,
      {
        type: "string",
        "x-clerk-sensitive": key === "client_secret",
      },
    ]),
  );
}

/**
 * Human-readable provider label, with shared metadata preferred.
 */
export function providerLabel(provider: string): string {
  return SHARED_OAUTH_METADATA.get(provider)?.name ?? fieldLabel(provider);
}

/**
 * Prompt fields for existing deploy callers, falling back to standard OAuth credentials.
 */
export function providerFields(provider: OAuthProvider): OAuthField[] {
  if (hasProviderOverride(provider)) return PROVIDER_FIELDS[provider];
  return [
    { key: "client_id", label: "Client ID" },
    { key: "client_secret", label: "Client Secret", secret: true },
  ];
}

/**
 * Credential action label for existing deploy callers.
 */
export function providerCredentialLabel(provider: OAuthProvider): string {
  if (hasProviderOverride(provider)) return PROVIDER_CREDENTIAL_LABELS[provider];
  return "I already have my Client ID and Client Secret";
}

function providerRedirectLabel(provider: OAuthProvider): string {
  if (hasProviderOverride(provider)) return PROVIDER_REDIRECT_LABELS[provider];
  return "Redirect URI";
}

function providerSetupCopy(provider: OAuthProvider): string {
  if (hasProviderOverride(provider)) return PROVIDER_SETUP_COPY[provider];
  return `Production ${providerLabel(provider)} sign-in requires custom OAuth credentials.`;
}

function providerGotcha(provider: OAuthProvider): string | null {
  if (hasProviderOverride(provider)) return PROVIDER_GOTCHAS[provider];
  return null;
}

function hasProviderOverride(provider: string): provider is ProviderWithOverride {
  return provider in PROVIDER_OVERRIDES;
}

function providerDescriptorFromInput(
  provider: OAuthProvider | OAuthProviderDescriptor,
): OAuthProviderDescriptor | undefined {
  return typeof provider === "string" ? undefined : provider;
}

/**
 * Build the provider setup intro shown before credential collection.
 */
export function providerSetupIntro(provider: OAuthProvider | OAuthProviderDescriptor): string[] {
  const descriptor = providerDescriptorFromInput(provider);
  const slug = descriptor?.provider ?? (provider as OAuthProvider);
  const label = descriptor?.label ?? providerLabel(slug);
  const setupCopy = descriptor?.setupCopy ?? providerSetupCopy(slug);
  const docsUrl = descriptor?.docsUrl ?? providerDocsUrl(slug);
  return [bold(`Configure ${label} OAuth for production`), setupCopy, dim(`Reference: ${docsUrl}`)];
}

/**
 * Show OAuth provider walkthrough values and open provider docs.
 */
export async function showOAuthWalkthrough(
  provider: OAuthProvider | OAuthProviderDescriptor,
  domain: string,
): Promise<void> {
  const descriptor = providerDescriptorFromInput(provider);
  const slug = descriptor?.provider ?? (provider as OAuthProvider);
  const label = descriptor?.label ?? providerLabel(slug);
  const docsUrl = descriptor?.docsUrl ?? providerDocsUrl(slug);

  log.info(`\nConfigure your ${bold(label)} OAuth app with these values:\n`);
  log.info(`  ${dim("Authorized JavaScript origins")}`);
  log.info(`    ${cyan(`https://${domain}`)}`);
  log.info(`    ${cyan(`https://www.${domain}`)}`);
  log.info(`  ${dim(descriptor?.redirectLabel ?? providerRedirectLabel(slug))}`);
  log.info(`    ${cyan(`https://accounts.${domain}/v1/oauth_callback`)}`);
  const gotcha = descriptor?.gotcha ?? providerGotcha(slug);
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
