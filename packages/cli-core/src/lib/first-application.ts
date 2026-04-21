import { listApplications, createApplication } from "./plapi.ts";
import { log } from "./log.ts";
import { DEFAULT_FIRST_APPLICATION_NAME } from "./constants.ts";

/**
 * Ensure the logged-in user has at least one application. Idempotent: lists
 * first and only creates when the list is empty. Intended to be called once
 * after a successful OAuth login; failures here are logged but never
 * propagate — a user who authenticated successfully should not see login
 * fail because of a best-effort bootstrap step.
 */
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
    log.debug(`ensure-first-app: failed (non-fatal): ${String(err)}`);
  }
}
