import { listApplications, createApplication } from "./plapi.ts";
import { log } from "./log.ts";
import { DEFAULT_FIRST_APPLICATION_NAME } from "./constants.ts";

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
    log.warn(
      "Could not set up a default application. You can create one at https://dashboard.clerk.com.",
    );
    log.debug(`ensure-first-app: failed (non-fatal): ${String(err)}`);
  }
}
