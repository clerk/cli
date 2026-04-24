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
import { runUserLifecycleCommand, type UserLifecycleOptions } from "./lifecycle-runner.ts";
import { handleUsersBapiError, printUsersMutationSuccess } from "./output.ts";

type MfaOptions = UserLifecycleOptions & {
  disable?: boolean;
  removeTotp?: boolean;
  removeBackupCodes?: boolean;
  verify?: boolean;
  code?: string;
};

export async function mfa(userId: string, options: MfaOptions = {}): Promise<void> {
  const actionCount =
    Number(Boolean(options.disable)) +
    Number(Boolean(options.removeTotp)) +
    Number(Boolean(options.removeBackupCodes)) +
    Number(Boolean(options.verify));

  if (actionCount !== 1) {
    throwUsageError(
      "Choose exactly one MFA action: --disable, --remove-totp, --remove-backup-codes, or --verify.",
    );
  }

  if (options.disable) {
    await runUserLifecycleCommand(
      {
        method: "DELETE",
        path: `/users/${userId}/mfa`,
        spinnerMessage: "Disabling MFA...",
      },
      options,
    );
    return;
  }

  if (options.removeTotp) {
    await runUserLifecycleCommand(
      {
        method: "DELETE",
        path: `/users/${userId}/totp`,
        spinnerMessage: "Removing user TOTP...",
      },
      options,
    );
    return;
  }

  if (options.removeBackupCodes) {
    await runUserLifecycleCommand(
      {
        method: "DELETE",
        path: `/users/${userId}/backup_code`,
        spinnerMessage: "Removing backup codes...",
      },
      options,
    );
    return;
  }

  if (!options.code) {
    throwUsageError("`clerk users mfa --verify` requires --code <value>.");
  }

  const payload = { code: options.code };
  const path = `/users/${userId}/verify_totp`;

  if (options.dryRun) {
    const target = await describeBapiTarget(options);
    const targetSuffix = target ? ` for ${target}` : "";
    log.info(`[dry-run] POST /v1/users/${userId}/verify_totp${targetSuffix}`);
    log.data(JSON.stringify(redactUsersDisplayPayload(payload), null, 2));
    return;
  }

  const secretKey = await resolveBapiSecretKey({
    secretKey: options.secretKey,
    app: options.app,
    instance: options.instance,
  });

  await confirmMfaVerification(path, payload, options);

  try {
    const response = await withSpinner("Verifying MFA code...", () =>
      bapiRequest({
        method: "POST",
        path,
        secretKey,
        body: JSON.stringify(payload),
      }),
    );

    printUsersMutationSuccess(`Verified MFA for user ${userId}`, response.body, options);
  } catch (error) {
    if (handleUsersBapiError(error, `Failed to verify MFA for user ${userId}`, options)) {
      return;
    }
    if (handleBapiError(error)) {
      return;
    }
    throw error;
  }
}

async function confirmMfaVerification(
  path: string,
  payload: Record<string, string>,
  options: Pick<MfaOptions, "yes">,
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
