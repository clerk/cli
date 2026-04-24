import { handleBapiError, resolveBapiSecretKey } from "../../lib/bapi-command.ts";
import { throwUsageError, throwUserAbort } from "../../lib/errors.ts";
import { log } from "../../lib/log.ts";
import {
  buildCreateUserPayload,
  mergeUsersPayload,
  parseUsersPayload,
  readUsersPayloadInput,
  redactUsersDisplayPayload,
} from "../../lib/users.ts";
import { isHuman } from "../../mode.ts";
import { bapiRequest } from "../api/bapi.ts";
import { confirm } from "../../lib/prompts.ts";
import { withSpinner } from "../../lib/spinner.ts";
import { handleUsersBapiError, printUsersMutationResult } from "./output.ts";
import { registerUsersAction } from "./registry.ts";
import { runCreateWizard } from "./create-wizard.ts";

type CreateUserOptions = {
  email?: string;
  phone?: string;
  username?: string;
  password?: string;
  firstName?: string;
  lastName?: string;
  externalId?: string;
  json?: boolean;
  data?: string;
  file?: string;
  app?: string;
  instance?: string;
  secretKey?: string;
  dryRun?: boolean;
  yes?: boolean;
};

export async function create(options: CreateUserOptions): Promise<void> {
  const payload = await resolveCreatePayload(options);

  if (options.dryRun) {
    log.info("[dry-run] POST /v1/users");
    log.data(JSON.stringify(redactUsersDisplayPayload(payload), null, 2));
    return;
  }

  await confirmMutation("POST", "/v1/users", payload, options);

  const secretKey = await resolveBapiSecretKey({
    secretKey: options.secretKey,
    app: options.app,
    instance: options.instance,
  });

  try {
    const response = await withSpinner("Creating user...", () =>
      bapiRequest({
        method: "POST",
        path: "/users",
        secretKey,
        body: JSON.stringify(payload),
      }),
    );

    printUsersMutationResult("Created user", response.body, options);
  } catch (error) {
    if (handleUsersBapiError(error, "Failed to create user", options)) {
      return;
    }
    if (handleBapiError(error)) {
      return;
    }
    throw error;
  }
}

async function resolveCreatePayload(options: CreateUserOptions): Promise<Record<string, unknown>> {
  const basePayload = await resolveBasePayload(options);
  return mergeUsersPayload(basePayload, buildCreateUserPayload(options));
}

async function resolveBasePayload(options: CreateUserOptions): Promise<Record<string, unknown>> {
  if (options.data || options.file) {
    return parseUsersPayload(
      await readUsersPayloadInput({ data: options.data, file: options.file }),
    );
  }

  if (hasCreateFlagPayload(options)) {
    return {};
  }

  if (isHuman()) {
    const wizardResult = await runCreateWizard({
      app: options.app,
      instance: options.instance,
      secretKey: options.secretKey,
    });
    if (Object.keys(wizardResult).length === 0) {
      throwUsageError(noInputMessage());
    }
    Object.assign(options, wizardResult);
    return {};
  }

  throwUsageError(noInputMessage());
  // unreachable
  return {};
}

function noInputMessage(): string {
  return (
    "No input provided. Pass curated flags, -d <json>, or --file <path>.\n" +
    "  Example: clerk users create --email alice@example.com --first-name Alice\n" +
    '  Example: clerk users create -d \'{"email_address":["alice@example.com"]}\'\n' +
    "  Example: clerk users create --file user.json"
  );
}

function hasCreateFlagPayload(options: CreateUserOptions): boolean {
  return Boolean(
    options.email ||
    options.phone ||
    options.username ||
    options.password ||
    options.firstName ||
    options.lastName ||
    options.externalId,
  );
}

async function confirmMutation(
  method: string,
  path: string,
  payload: Record<string, unknown>,
  options: { yes?: boolean },
): Promise<void> {
  if (!isHuman() || options.yes) return;

  log.info(`About to ${method} ${path}`);
  const display = redactUsersDisplayPayload(payload);
  for (const line of formatPayloadForDisplay(display)) {
    log.info(line);
  }

  const ok = await confirm({ message: "Proceed?" });
  if (!ok) {
    throwUserAbort();
  }
}

function formatPayloadForDisplay(payload: unknown): string[] {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return [`  ${formatPayloadValue(payload)}`];
  }
  return Object.entries(payload as Record<string, unknown>).map(
    ([key, value]) => `  ${key}: ${formatPayloadValue(value)}`,
  );
}

function formatPayloadValue(value: unknown): string {
  if (value === null || value === undefined) return "(none)";
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  if (Array.isArray(value) && value.length === 1 && typeof value[0] === "string") {
    return value[0];
  }
  return JSON.stringify(value);
}

registerUsersAction({
  key: "create",
  label: "Create user",
  description: "Create a new user",
  handler: async (targeting) => {
    await create(targeting);
  },
});
