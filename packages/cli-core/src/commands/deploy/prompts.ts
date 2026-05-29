import { input, password } from "@inquirer/prompts";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { select } from "../../lib/listage.ts";
import { confirm } from "../../lib/prompts.ts";
import { type OAuthPromptField, type OAuthProviderDescriptor } from "./providers.ts";

type OAuthCredentialAction = "have-credentials" | "walkthrough" | "google-json" | "skip";
type DnsVerificationAction = "check" | "skip";

const PROVIDER_DOMAIN_SUFFIXES = [
  ".clerk.app",
  ".vercel.app",
  ".netlify.app",
  ".pages.dev",
  ".fly.dev",
  ".render.com",
  ".herokuapp.com",
];

export async function confirmProceed(): Promise<boolean> {
  return confirm({ message: "Proceed?", default: true });
}

export async function collectCustomDomain(): Promise<string> {
  const domain = await input({
    message: "Production domain (e.g. example.com)",
    validate: (value) => validateDomain(value),
  });
  return domain.trim();
}

export function validateDomain(value: string): true | string {
  const domain = value.trim();
  if (!domain) return "Enter a domain.";
  if (domain.startsWith("http://") || domain.startsWith("https://")) {
    return "Enter a valid domain, such as example.com (without https://).";
  }
  if (!/^([a-z0-9]([a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/i.test(domain)) {
    return "Enter a valid domain, such as example.com (without https://).";
  }
  if (PROVIDER_DOMAIN_SUFFIXES.some((suffix) => domain.toLowerCase().endsWith(suffix))) {
    return `${domain} looks like a provider domain (e.g. *.vercel.app, *.clerk.app). Production needs a domain you own. See https://clerk.com/docs/guides/development/deployment/production`;
  }
  return true;
}

export async function confirmCreateProductionInstance(): Promise<boolean> {
  return confirm({
    message: "Create production instance?",
    default: true,
  });
}

export async function chooseDnsVerificationAction(): Promise<DnsVerificationAction> {
  return select({
    message: "DNS verification",
    choices: [
      { name: "Check DNS now", value: "check" },
      { name: "Skip DNS verification for now", value: "skip" },
    ],
  });
}

export async function chooseDnsVerificationRetryAction(): Promise<DnsVerificationAction> {
  return select({
    message: "DNS verification",
    choices: [
      { name: "Skip DNS verification for now", value: "skip" },
      { name: "Check again", value: "check" },
    ],
  });
}

export async function confirmExportBindZone(): Promise<boolean> {
  return confirm({
    message: "Export DNS records as a BIND zone file?",
    default: false,
  });
}

export async function chooseOAuthCredentialAction(
  descriptor: OAuthProviderDescriptor,
): Promise<OAuthCredentialAction> {
  const choices: Array<{ name: string; value: OAuthCredentialAction }> = [
    { name: descriptor.credentialLabel, value: "have-credentials" },
    { name: "Walk me through creating them", value: "walkthrough" },
  ];
  if (descriptor.credentialSources.includes("google-json")) {
    choices.push({
      name: "Load credentials from a Google Cloud Console JSON file",
      value: "google-json",
    });
  }
  choices.push({
    name: "Skip for now and run `clerk deploy` again later",
    value: "skip",
  });

  return select({
    message: `${descriptor.label} OAuth`,
    choices,
  });
}

export async function chooseExistingProductionAction(): Promise<
  "resume" | "next-steps" | "cancel"
> {
  return select({
    message: "What would you like to do?",
    choices: [
      { name: "Resume the next incomplete step", value: "resume" },
      { name: "Show next steps and exit", value: "next-steps" },
      { name: "Cancel", value: "cancel" },
    ],
  });
}

export async function collectOAuthCredentials(
  descriptor: OAuthProviderDescriptor,
  source: "manual" | "google-json" = "manual",
): Promise<Record<string, string>> {
  if (descriptor.provider === "google" && source === "google-json") {
    return collectGoogleJsonCredentials();
  }

  const credentials: Record<string, string> = {};
  for (const field of descriptor.fields) {
    credentials[field.key] = await collectOAuthField(descriptor, field);
  }
  return credentials;
}

async function collectOAuthField(
  descriptor: OAuthProviderDescriptor,
  field: OAuthPromptField,
): Promise<string> {
  const message = `${descriptor.label} OAuth ${field.label}`;
  let value: string;
  if (field.filePath) {
    const path = await input({ message, validate: validateSecretFilePath(field.label) });
    value = await readSecretFile(path);
  } else if (field.type === "select") {
    value = await select({
      message,
      choices: (field.options ?? []).map((option) => ({ name: option, value: option })),
      default: field.defaultValue,
    });
  } else if (field.secret) {
    value = await password({ message, validate: required(field.label) });
  } else {
    value = await input({
      message,
      default: field.defaultValue,
      validate: required(field.label),
    });
  }
  return field.filePath ? value : value.trim();
}

function validateSecretFilePath(label: string) {
  return async (path: string): Promise<true | string> => {
    if (!path.trim()) return `${label} is required`;
    try {
      await readSecretFile(path);
      return true;
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  };
}

async function collectGoogleJsonCredentials(): Promise<Record<string, string>> {
  const path = await input({
    message: "Google OAuth JSON file path",
    validate: validateGoogleJsonFilePath,
  });
  return readGoogleJsonCredentials(path);
}

async function validateGoogleJsonFilePath(path: string): Promise<true | string> {
  if (!path.trim()) return "Google OAuth JSON file path is required";
  try {
    await readGoogleJsonCredentials(path);
    return true;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

async function readGoogleJsonCredentials(path: string): Promise<Record<string, string>> {
  const raw = await readTextFile(path);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(
      `That JSON file doesn't look like a Google OAuth client download. Expected a "web" or "installed" object.`,
    );
  }

  const root = parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  const client = (root.web ?? root.installed) as Record<string, unknown> | undefined;
  if (
    !client ||
    typeof client !== "object" ||
    typeof client.client_id !== "string" ||
    typeof client.client_secret !== "string"
  ) {
    throw new Error(
      `That JSON file doesn't look like a Google OAuth client download. Expected a "web" or "installed" object.`,
    );
  }

  return {
    client_id: client.client_id,
    client_secret: client.client_secret,
  };
}

function required(label: string) {
  return (value: string) => value.trim().length > 0 || `${label} is required`;
}

function expandPath(path: string): string {
  let expanded = path;
  if (path === "~") expanded = homedir();
  else if (path.startsWith("~/")) expanded = join(homedir(), path.slice(2));
  return resolve(expanded);
}

async function readSecretFile(path: string): Promise<string> {
  const contents = await readTextFile(path);
  if (
    !contents.includes("-----BEGIN PRIVATE KEY-----") ||
    !contents.includes("-----END PRIVATE KEY-----")
  ) {
    throw new Error(
      "That file is missing the -----BEGIN PRIVATE KEY----- framing. Make sure you selected the .p8 file Apple gave you.",
    );
  }
  return contents;
}

async function readTextFile(path: string): Promise<string> {
  const expanded = expandPath(path.trim());
  const file = Bun.file(expanded);
  if (!(await file.exists())) {
    throw new Error(`No file at ${path}.`);
  }
  try {
    return await file.text();
  } catch (error) {
    throw new Error(
      `Cannot read ${path}: ${error instanceof Error ? error.message : String(error)}.`,
    );
  }
}
