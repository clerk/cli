import { listApplications, createApplication } from "./plapi.ts";
import { log } from "./log.ts";
import { DEFAULT_FIRST_APPLICATION_NAME } from "./constants.ts";
import { platformPermissionProblem } from "./errors.ts";

/** Create a default app for first-time users; no-op if any app already exists. */
export async function ensureFirstApplication(): Promise<void> {
  try {
    const apps = await listApplications();
    if (apps.length > 0) {
      log.debug(`ensure-first-app: user has ${apps.length} application(s), skipping`);
      return;
    }
    const created = await createApplication(DEFAULT_FIRST_APPLICATION_NAME);
    log.debug(`ensure-first-app: created ${created.application_id}`);
  } catch (err) {
    const permission = platformPermissionProblem(err);
    log.warn(
      permission
        ? `Could not set up a default application. ${permission.message}`
        : "Could not set up a default application. Run `clerk apps create` to create one.",
    );
    log.debug(`ensure-first-app: failed (non-fatal): ${String(err)}`);
  }
}
