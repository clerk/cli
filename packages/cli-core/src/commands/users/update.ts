import { handleBapiError, resolveBapiSecretKey } from "../../lib/bapi-command.ts";
import { throwUsageError, throwUserAbort } from "../../lib/errors.ts";
import { log } from "../../lib/log.ts";
import {
  buildUpdateUserPayload,
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

type UpdateUserOptions = {
  firstName?: string;
  lastName?: string;
  username?: string;
  password?: string;
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

export async function update(userId: string, options: UpdateUserOptions): Promise<void> {
  const payload = await resolveUpdatePayload(options);

  if (options.dryRun) {
    log.info(`[dry-run] PATCH /v1/users/${userId}`);
    log.data(JSON.stringify(redactUsersDisplayPayload(payload), null, 2));
    return;
  }

  await confirmMutation("PATCH", `/v1/users/${userId}`, payload, options);

  const secretKey = await resolveBapiSecretKey({
    secretKey: options.secretKey,
    app: options.app,
    instance: options.instance,
  });

  try {
    const response = await withSpinner("Updating user...", () =>
      bapiRequest({
        method: "PATCH",
        path: `/users/${userId}`,
        secretKey,
        body: JSON.stringify(payload),
      }),
    );

    printUsersMutationResult("Updated user", response.body, options);
  } catch (error) {
    if (handleUsersBapiError(error, `Failed to update user ${userId}`, options)) {
      return;
    }
    if (handleBapiError(error)) {
      return;
    }
    throw error;
  }
}

async function resolveUpdatePayload(options: UpdateUserOptions): Promise<Record<string, unknown>> {
  const basePayload = await resolveBasePayload(options, hasUpdateFlagPayload(options));
  return mergeUsersPayload(basePayload, buildUpdateUserPayload(options));
}

async function resolveBasePayload(
  options: { data?: string; file?: string },
  hasFlagPayload: boolean,
): Promise<Record<string, unknown>> {
  if (options.data || options.file) {
    return parseUsersPayload(
      await readUsersPayloadInput({ data: options.data, file: options.file }),
    );
  }

  if (hasFlagPayload) {
    return {};
  }

  throwUsageError(
    "No input provided. Pass curated flags, -d <json>, or --file <path>.\n" +
      "  Example: clerk users update user_123 --first-name Alice\n" +
      "  Example: clerk users update user_123 -d '{\"first_name\":\"Alice\"}'\n" +
      "  Example: clerk users update user_123 --file user.json",
  );
}

function hasUpdateFlagPayload(options: UpdateUserOptions): boolean {
  return Boolean(
    options.firstName ||
      options.lastName ||
      options.username ||
      options.password ||
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

  log.info(`\nAbout to ${method} ${path}`);
  log.raw(JSON.stringify(redactUsersDisplayPayload(payload), null, 2));

  const ok = await confirm({ message: "Proceed?" });
  if (!ok) {
    throwUserAbort();
  }
}
