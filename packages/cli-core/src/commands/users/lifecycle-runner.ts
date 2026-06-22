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
import { bapiRequest } from "../../lib/bapi.ts";
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

const LIFECYCLE_LABELS: Record<string, { success: string; error: string }> = {
  "/ban": { success: "Banned user", error: "Failed to ban user" },
  "/unban": { success: "Unbanned user", error: "Failed to unban user" },
  "/lock": { success: "Locked user", error: "Failed to lock user" },
  "/unlock": { success: "Unlocked user", error: "Failed to unlock user" },
  "/profile_image": {
    success: "Removed profile image for user",
    error: "Failed to remove profile image for user",
  },
  "/mfa": { success: "Disabled MFA for user", error: "Failed to disable MFA for user" },
  "/totp": { success: "Removed TOTP for user", error: "Failed to remove TOTP for user" },
  "/backup_code": {
    success: "Removed backup codes for user",
    error: "Failed to remove backup codes for user",
  },
};

function getLifecycleLabel(path: string, type: "success" | "error"): string {
  const userId = getUserIdFromPath(path);
  const suffix = "/" + (path.split("/").pop() ?? "");
  const labels = LIFECYCLE_LABELS[suffix];
  const fallback = type === "success" ? "Updated user" : "Failed to update user";
  return `${labels?.[type] ?? fallback} ${userId}`;
}

function getLifecycleSuccessMessage(path: string): string {
  return getLifecycleLabel(path, "success");
}

function getLifecycleErrorMessage(path: string): string {
  return getLifecycleLabel(path, "error");
}

function getUserIdFromPath(path: string): string {
  return path.split("/")[2] ?? "unknown";
}
