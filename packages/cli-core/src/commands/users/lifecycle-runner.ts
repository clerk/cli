import {
  describeBapiTarget,
  handleBapiError,
  normalizeBapiPath,
  resolveBapiSecretKey,
} from "../../lib/bapi-command.ts";
import { throwUserAbort } from "../../lib/errors.ts";
import { log } from "../../lib/log.ts";
import { confirm } from "../../lib/prompts.ts";
import { withSpinner } from "../../lib/spinner.ts";
import { isHuman } from "../../mode.ts";
import { bapiRequest } from "../api/bapi.ts";
import { handleUsersBapiError, printUsersMutationSuccess } from "./output.ts";

export type UserLifecycleOptions = {
  json?: boolean;
  secretKey?: string;
  app?: string;
  instance?: string;
  dryRun?: boolean;
  yes?: boolean;
};

type UserLifecycleCommand = {
  method: "DELETE" | "POST";
  path: string;
  spinnerMessage: string;
  destructiveWarning?: string;
  successMessage?: string;
  errorMessage?: string;
};

export async function runUserLifecycleCommand(
  command: UserLifecycleCommand,
  options: UserLifecycleOptions = {},
): Promise<void> {
  if (options.dryRun) {
    const target = await describeBapiTarget(options);
    const targetSuffix = target ? ` for ${target}` : "";
    log.info(`[dry-run] ${command.method} ${normalizeBapiPath(command.path)}${targetSuffix}`);
    return;
  }

  const secretKey = await resolveBapiSecretKey({
    secretKey: options.secretKey,
    app: options.app,
    instance: options.instance,
  });

  if (isHuman() && !options.yes) {
    log.info(`\nAbout to ${command.method} ${command.path}`);
    if (command.destructiveWarning) {
      log.info(command.destructiveWarning);
    }
    const ok = await confirm({ message: "Proceed?" });
    if (!ok) {
      throwUserAbort();
    }
  }

  try {
    const response = await withSpinner(command.spinnerMessage, () =>
      bapiRequest({
        method: command.method,
        path: command.path,
        secretKey,
      }),
    );

    printUsersMutationSuccess(
      command.successMessage ?? getLifecycleSuccessMessage(command.path),
      response.body,
      options,
    );
  } catch (error) {
    if (
      handleUsersBapiError(
        error,
        command.errorMessage ?? getLifecycleErrorMessage(command.path),
        options,
      )
    ) {
      return;
    }
    if (handleBapiError(error)) {
      return;
    }
    throw error;
  }
}

function getLifecycleSuccessMessage(path: string): string {
  const userId = getUserIdFromPath(path);

  if (path.endsWith("/ban")) {
    return `Banned user ${userId}`;
  }
  if (path.endsWith("/unban")) {
    return `Unbanned user ${userId}`;
  }
  if (path.endsWith("/lock")) {
    return `Locked user ${userId}`;
  }
  if (path.endsWith("/unlock")) {
    return `Unlocked user ${userId}`;
  }
  if (path.endsWith("/profile_image")) {
    return `Removed profile image for user ${userId}`;
  }
  if (path.endsWith("/mfa")) {
    return `Disabled MFA for user ${userId}`;
  }
  if (path.endsWith("/totp")) {
    return `Removed TOTP for user ${userId}`;
  }
  if (path.endsWith("/backup_code")) {
    return `Removed backup codes for user ${userId}`;
  }

  return `Updated user ${userId}`;
}

function getLifecycleErrorMessage(path: string): string {
  const userId = getUserIdFromPath(path);

  if (path.endsWith("/ban")) {
    return `Failed to ban user ${userId}`;
  }
  if (path.endsWith("/unban")) {
    return `Failed to unban user ${userId}`;
  }
  if (path.endsWith("/lock")) {
    return `Failed to lock user ${userId}`;
  }
  if (path.endsWith("/unlock")) {
    return `Failed to unlock user ${userId}`;
  }
  if (path.endsWith("/profile_image")) {
    return `Failed to remove profile image for user ${userId}`;
  }
  if (path.endsWith("/mfa")) {
    return `Failed to disable MFA for user ${userId}`;
  }
  if (path.endsWith("/totp")) {
    return `Failed to remove TOTP for user ${userId}`;
  }
  if (path.endsWith("/backup_code")) {
    return `Failed to remove backup codes for user ${userId}`;
  }

  return `Failed to update user ${userId}`;
}

function getUserIdFromPath(path: string): string {
  return path.split("/")[2] ?? "unknown";
}
