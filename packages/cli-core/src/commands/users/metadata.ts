import {
  describeBapiTarget,
  handleBapiError,
  resolveBapiSecretKey,
} from "../../lib/bapi-command.ts";
import { throwUsageError, throwUserAbort } from "../../lib/errors.ts";
import { log } from "../../lib/log.ts";
import { confirm } from "../../lib/prompts.ts";
import {
  parseUsersPayload,
  readUsersPayloadInput,
  redactUsersDisplayPayload,
} from "../../lib/users.ts";
import { withSpinner } from "../../lib/spinner.ts";
import { isHuman } from "../../mode.ts";
import { bapiRequest } from "../api/bapi.ts";
import { handleUsersBapiError, printUsersMutationSuccess } from "./output.ts";

type MetadataOptions = {
  json?: boolean;
  data?: string;
  file?: string;
  secretKey?: string;
  app?: string;
  instance?: string;
  dryRun?: boolean;
  yes?: boolean;
};

export async function metadata(userId: string, options: MetadataOptions = {}): Promise<void> {
  const payload = parseUsersPayload(await readMetadataPayloadInput(userId, options));
  const path = `/users/${userId}/metadata`;

  if (options.dryRun) {
    const target = await describeBapiTarget(options);
    const targetSuffix = target ? ` for ${target}` : "";
    log.info(`[dry-run] PATCH /v1/users/${userId}/metadata${targetSuffix}`);
    log.data(JSON.stringify(redactUsersDisplayPayload(payload), null, 2));
    return;
  }

  if (isHuman() && !options.yes) {
    log.info(`\nAbout to PATCH ${path}`);
    log.raw(JSON.stringify(redactUsersDisplayPayload(payload), null, 2));

    const ok = await confirm({ message: "Proceed?" });
    if (!ok) {
      throwUserAbort();
    }
  }

  const secretKey = await resolveBapiSecretKey({
    secretKey: options.secretKey,
    app: options.app,
    instance: options.instance,
  });
  try {
    const response = await withSpinner("Updating user metadata...", () =>
      bapiRequest({
        method: "PATCH",
        path,
        secretKey,
        body: JSON.stringify(payload),
      }),
    );

    printUsersMutationSuccess(`Updated metadata for user ${userId}`, response.body, options);
  } catch (error) {
    if (handleUsersBapiError(error, `Failed to update metadata for user ${userId}`, options)) {
      return;
    }
    if (handleBapiError(error)) {
      return;
    }
    throw error;
  }
}

async function readMetadataPayloadInput(
  userId: string,
  options: Pick<MetadataOptions, "data" | "file">,
): Promise<string> {
  if (!options.data && !options.file) {
    throwUsageError(
      "No input provided. Use -d <json> or --file <path>.\n" +
        `  Example: clerk users metadata ${userId} --file metadata.json\n` +
        `  Example: clerk users metadata ${userId} -d '{"public_metadata":{"role":"admin"}}'`,
    );
  }

  return readUsersPayloadInput({ data: options.data, file: options.file });
}
