import { input, password } from "@inquirer/prompts";
import {
  bootstrapDevBrowser,
  decodePublishableKey,
  fetchUserSettings,
  type InstanceType,
  type UserSettingsJSON,
} from "../../lib/fapi.ts";
import { withSpinner } from "../../lib/spinner.ts";
import { isEnabled, isRequired, type AttributeName } from "./interactive/attributes.ts";
import { resolveUsersInstanceContext } from "./interactive/instance-context.ts";

export type CreateWizardResult = {
  email?: string;
  phone?: string;
  username?: string;
  password?: string;
  firstName?: string;
  lastName?: string;
};

type WizardOptions = {
  app?: string;
  instance?: string;
  secretKey?: string;
};

type FieldDef = {
  attr: AttributeName;
  key: keyof CreateWizardResult;
  message: string;
  isPassword?: boolean;
};

const ALL_FIELDS: FieldDef[] = [
  { attr: "email_address", key: "email", message: "Email address" },
  { attr: "phone_number", key: "phone", message: "Phone number" },
  { attr: "username", key: "username", message: "Username" },
  { attr: "password", key: "password", message: "Password", isPassword: true },
  { attr: "first_name", key: "firstName", message: "First name" },
  { attr: "last_name", key: "lastName", message: "Last name" },
];

export async function runCreateWizard(options: WizardOptions): Promise<CreateWizardResult> {
  const ctx = await resolveUsersInstanceContext(options);
  const settings =
    ctx.fapiHost && ctx.publishableKey
      ? await loadSettings(ctx.fapiHost, decodePublishableKey(ctx.publishableKey).instanceType)
      : undefined;

  const result: CreateWizardResult = {};
  for (const field of ALL_FIELDS) {
    const enabled = settings ? isEnabled(settings, field.attr) : true;
    if (!enabled) continue;
    const required = settings ? isRequired(settings, field.attr) : false;
    const value = await promptField(field, required);
    if (value) result[field.key] = value;
  }
  return result;
}

async function loadSettings(
  fapiHost: string,
  instanceType: InstanceType,
): Promise<UserSettingsJSON> {
  return withSpinner("Loading instance settings...", async () => {
    const jwt = instanceType === "development" ? await bootstrapDevBrowser(fapiHost) : undefined;
    return fetchUserSettings(fapiHost, jwt ? { jwt } : {});
  });
}

async function promptField(field: FieldDef, required: boolean): Promise<string> {
  const message = required ? `${field.message} *` : `${field.message} (optional)`;
  const validate = required
    ? (value: string) => value.trim().length > 0 || `${field.message} is required`
    : undefined;
  if (field.isPassword) {
    const value = await password({ message, validate });
    return value.trim();
  }
  const value = await input({ message, validate });
  return value.trim();
}
