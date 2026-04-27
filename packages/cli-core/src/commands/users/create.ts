import { handleBapiError, resolveBapiSecretKey } from "../../lib/bapi-command.ts";
import { throwUsageError } from "../../lib/errors.ts";
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
    const { fields, targeting } = await runCreateWizard({
      app: options.app,
      instance: options.instance,
      secretKey: options.secretKey,
    });
    if (Object.keys(fields).length === 0) {
      throwUsageError(noInputMessage());
    }
    Object.assign(options, targeting, fields);
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

registerUsersAction({
  key: "create",
  label: "Create user",
  description: "Create a new user",
  handler: async (targeting) => {
    await create(targeting);
  },
});
