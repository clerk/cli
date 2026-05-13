import { handleBapiError, resolveBapiSecretKey } from "../../lib/bapi-command.ts";
import { throwUsageError } from "../../lib/errors.ts";
import { isInsideGutter, log } from "../../lib/log.ts";
import {
  buildCreateUserPayload,
  mergeUsersPayload,
  parseUsersPayload,
  readUsersPayloadInput,
  redactUsersDisplayPayload,
} from "../../lib/users.ts";
import { isHuman } from "../../mode.ts";
import { bapiRequest } from "../api/bapi.ts";
import { withSpinner, intro, outro } from "../../lib/spinner.ts";
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

type ResolvedCreate = {
  payload: Record<string, unknown>;
  resolved: CreateUserOptions;
};

export async function create(options: CreateUserOptions): Promise<void> {
  const { payload, resolved } = await resolveCreate(options);

  const nested = isInsideGutter();

  if (resolved.dryRun) {
    if (!nested) intro("Creating user");
    log.info("[dry-run] POST /v1/users");
    log.blank();
    log.info(JSON.stringify(redactUsersDisplayPayload(payload), null, 2));
    return;
  }

  const secretKey = await resolveBapiSecretKey({
    secretKey: resolved.secretKey,
    app: resolved.app,
    instance: resolved.instance,
  });

  if (!nested) intro("Creating user");

  try {
    const response = await withSpinner("Creating user...", () =>
      bapiRequest({
        method: "POST",
        path: "/users",
        secretKey,
        body: JSON.stringify(payload),
      }),
    );

    printUsersMutationResult("Created user", response.body, resolved);
    if (!nested) {
      const userId = extractUserId(response.body);
      if (userId) {
        outro([`Run \`clerk users open ${userId}\` to view this user in the dashboard`]);
      } else {
        outro();
      }
    }
  } catch (error) {
    if (handleUsersBapiError(error, "Failed to create user", resolved)) {
      if (!nested) outro("Failed");
      return;
    }
    if (handleBapiError(error)) {
      if (!nested) outro("Failed");
      return;
    }
    throw error;
  }
}

function extractUserId(body: unknown): string | undefined {
  if (!body || typeof body !== "object" || Array.isArray(body)) return undefined;
  const { id } = body as { id?: unknown };
  return typeof id === "string" && id.length > 0 ? id : undefined;
}

async function resolveCreate(options: CreateUserOptions): Promise<ResolvedCreate> {
  const { basePayload, resolved } = await resolveBasePayload(options);
  return {
    payload: mergeUsersPayload(basePayload, buildCreateUserPayload(resolved)),
    resolved,
  };
}

async function resolveBasePayload(options: CreateUserOptions): Promise<{
  basePayload: Record<string, unknown>;
  resolved: CreateUserOptions;
}> {
  if (options.data || options.file) {
    return {
      basePayload: parseUsersPayload(
        await readUsersPayloadInput({ data: options.data, file: options.file }),
      ),
      resolved: options,
    };
  }

  if (hasCreateFlagPayload(options)) {
    return { basePayload: {}, resolved: options };
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
    return { basePayload: {}, resolved: { ...options, ...targeting, ...fields } };
  }

  throwUsageError(noInputMessage());
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
