import {
  describeBapiTarget,
  handleBapiError,
  resolveBapiSecretKey,
} from "../../lib/bapi-command.ts";
import { throwUsageError, throwUserAbort } from "../../lib/errors.ts";
import { log } from "../../lib/log.ts";
import { confirm } from "../../lib/prompts.ts";
import { redactUsersDisplayPayload } from "../../lib/users.ts";
import { withSpinner } from "../../lib/spinner.ts";
import { isHuman } from "../../mode.ts";
import { bapiRequest } from "../api/bapi.ts";
import { handleUsersBapiError, printUsersMutationSuccess } from "./output.ts";

type PasswordOptions = {
  verify?: boolean;
  password?: string;
  json?: boolean;
  secretKey?: string;
  app?: string;
  instance?: string;
  dryRun?: boolean;
  yes?: boolean;
};

export async function password(userId: string, options: PasswordOptions = {}): Promise<void> {
  const actionCount = Number(Boolean(options.verify));
  if (actionCount !== 1) {
    throwUsageError("Choose exactly one password action. Use --verify with --password <value>.");
  }

  if (!options.password) {
    throwUsageError("`clerk users password --verify` requires --password <value>.");
  }

  const payload = { password: options.password };
  const path = `/users/${userId}/verify_password`;

  if (options.dryRun) {
    const target = await describeBapiTarget(options);
    const targetSuffix = target ? ` for ${target}` : "";
    log.info(`[dry-run] POST /v1/users/${userId}/verify_password${targetSuffix}`);
    log.data(JSON.stringify(redactUsersDisplayPayload(payload), null, 2));
    return;
  }

  const secretKey = await resolveBapiSecretKey({
    secretKey: options.secretKey,
    app: options.app,
    instance: options.instance,
  });

  await confirmPasswordVerification(path, payload, options);

  try {
    const response = await withSpinner("Verifying password...", () =>
      bapiRequest({
        method: "POST",
        path,
        secretKey,
        body: JSON.stringify(payload),
      }),
    );

    printUsersMutationSuccess(`Verified password for user ${userId}`, response.body, options);
  } catch (error) {
    if (handleUsersBapiError(error, `Failed to verify password for user ${userId}`, options)) {
      return;
    }
    if (handleBapiError(error)) {
      return;
    }
    throw error;
  }
}

async function confirmPasswordVerification(
  path: string,
  payload: Record<string, string>,
  options: Pick<PasswordOptions, "yes">,
): Promise<void> {
  if (!isHuman() || options.yes) {
    return;
  }

  log.info(`\nAbout to POST ${path}`);
  log.raw(JSON.stringify(redactUsersDisplayPayload(payload), null, 2));

  const ok = await confirm({ message: "Proceed?" });
  if (!ok) {
    throwUserAbort();
  }
}
