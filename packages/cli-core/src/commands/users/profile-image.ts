import { basename } from "node:path";
import { getBapiBaseUrl } from "../../lib/environment.ts";
import { BapiError, ERROR_CODE, throwUsageError, throwUserAbort } from "../../lib/errors.ts";
import { loggedFetch } from "../../lib/fetch.ts";
import { log } from "../../lib/log.ts";
import { confirm } from "../../lib/prompts.ts";
import { withSpinner } from "../../lib/spinner.ts";
import {
  describeBapiTarget,
  handleBapiError,
  normalizeBapiPath,
  resolveBapiSecretKey,
} from "../../lib/bapi-command.ts";
import { isHuman } from "../../mode.ts";
import { runUserLifecycleCommand, type UserLifecycleOptions } from "./lifecycle-runner.ts";
import { handleUsersBapiError, printUsersMutationSuccess } from "./output.ts";

type ProfileImageOptions = UserLifecycleOptions & {
  set?: string;
  remove?: boolean;
};

export async function profileImage(
  userId: string,
  options: ProfileImageOptions = {},
): Promise<void> {
  const actionCount = Number(Boolean(options.set)) + Number(Boolean(options.remove));
  if (actionCount !== 1) {
    throwUsageError("Choose exactly one profile image action: use --set <path> or --remove.");
  }

  if (options.remove) {
    await runUserLifecycleCommand(
      {
        method: "DELETE",
        path: `/users/${userId}/profile_image`,
        spinnerMessage: "Removing profile image...",
      },
      options,
    );
    return;
  }

  const imagePath = options.set!;
  const file = Bun.file(imagePath);
  if (!(await file.exists())) {
    throwUsageError(`File not found: ${imagePath}`, undefined, ERROR_CODE.FILE_NOT_FOUND);
  }

  const path = `/users/${userId}/profile_image`;
  if (options.dryRun) {
    const target = await describeBapiTarget(options);
    const targetSuffix = target ? ` for ${target}` : "";
    log.info(`[dry-run] POST /v1/users/${userId}/profile_image${targetSuffix}`);
    log.data(JSON.stringify({ file: imagePath }, null, 2));
    return;
  }

  if (isHuman() && !options.yes) {
    log.info(`\nAbout to POST ${path}`);
    log.raw(JSON.stringify({ file: imagePath }, null, 2));

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
    const response = await withSpinner("Uploading profile image...", async () => {
      const formData = new FormData();
      formData.set("file", file, basename(imagePath));

      const url = `${getBapiBaseUrl()}${normalizeBapiPath(path)}`;
      const rawResponse = await loggedFetch(url, {
        tag: "bapi",
        method: "POST",
        headers: {
          Authorization: `Bearer ${secretKey}`,
          Accept: "application/json",
        },
        body: formData,
      });
      const rawBody = await rawResponse.text();

      if (!rawResponse.ok) {
        throw new BapiError(rawResponse.status, rawBody, rawResponse.headers);
      }

      let body: unknown;
      try {
        body = JSON.parse(rawBody);
      } catch {
        body = rawBody;
      }

      return {
        status: rawResponse.status,
        headers: rawResponse.headers,
        body,
      };
    });

    printUsersMutationSuccess(`Set profile image for user ${userId}`, response.body, options);
  } catch (error) {
    if (handleUsersBapiError(error, `Failed to set profile image for user ${userId}`, options)) {
      return;
    }
    if (handleBapiError(error)) {
      return;
    }
    throw error;
  }
}
