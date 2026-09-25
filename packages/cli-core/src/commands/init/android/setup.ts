import { createHash } from "node:crypto";
import { resolveAppContext } from "../../../lib/config.ts";
import { CliError, PlapiError, throwUserAbort } from "../../../lib/errors.ts";
import { log } from "../../../lib/log.ts";
import { confirm } from "../../../lib/prompts.ts";
import {
  createAndroidApplication,
  enableNativeApi,
  fetchApplication,
  getNativeSettings,
  listAndroidApplications,
  type AndroidApplication,
} from "../../../lib/plapi.ts";
import { previewPlan } from "../preview.ts";
import {
  applyAndroidProject,
  assertProjectUnchanged,
  normalizeFingerprints,
  withPublishableKey,
  type AndroidProject,
} from "./project.ts";

function matchingRegistration(
  apps: AndroidApplication[],
  project: AndroidProject,
): AndroidApplication | undefined {
  const matches = apps.filter((app) => app.package_name === project.packageName);
  if (matches.length > 1)
    throw new CliError(
      "Multiple Android registrations matched the applicationId. Review Native Applications in the Dashboard.",
    );
  const app = matches[0];
  if (
    app &&
    (app.namespace !== "android_app" ||
      !project.fingerprints.every((fp) => normalizeFingerprints(app.fingerprints).includes(fp)))
  ) {
    throw new CliError(
      "The existing Android registration has a different namespace or is missing requested signing fingerprints. Update it in Dashboard > Native Applications, then rerun init. Local project files were not changed.",
    );
  }
  return app;
}

export async function setupAndroid(
  project: AndroidProject,
  options: { app?: string; skipConfirm: boolean },
): Promise<void> {
  const target = options.app
    ? { appId: options.app, instanceId: undefined }
    : await resolveAppContext({
        cwd: project.root,
        app: options.app,
        instance: "development",
      });
  // Confirm the instance using authoritative application metadata, not a stale saved profile.
  const application = await fetchApplication(target.appId, { includeSecretKeys: false });
  const instance = application.instances.find((entry) => entry.environment_type === "development");
  if (!instance || (target.instanceId && instance.instance_id !== target.instanceId))
    throw new CliError(
      "The linked development instance changed. Run clerk link again before Android setup.",
    );
  const prepared = withPublishableKey(project, instance.publishable_key);
  const [settings, registrations] = await Promise.all([
    getNativeSettings(target.appId, instance.instance_id),
    listAndroidApplications(target.appId, instance.instance_id),
  ]);
  const existing = matchingRegistration(registrations, project);
  log.info(
    `Android setup: ${project.packageName} → ${target.appId} / development (${instance.instance_id})`,
  );
  log.info(settings.api_enabled ? "Native API is already enabled." : "Enable Native API.");
  log.info(
    existing
      ? "Reuse the existing Android registration."
      : `Register Android application with ${project.fingerprints.length} signing fingerprint(s).`,
  );
  previewPlan(prepared.plan);
  const hasChanges = !settings.api_enabled || !existing || prepared.plan.actions.length > 0;
  if (hasChanges && !options.skipConfirm && !(await confirm({ message: "Apply Android setup?" })))
    throwUserAbort();
  await assertProjectUnchanged(prepared);
  if (!settings.api_enabled) {
    const enabled = await enableNativeApi(target.appId, instance.instance_id);
    if (!enabled.api_enabled)
      throw new CliError(
        "Native API was not enabled. Android setup stopped before registration or local writes.",
      );
  }
  if (!existing) {
    const params = {
      namespace: "android_app" as const,
      package_name: project.packageName,
      fingerprints: project.fingerprints,
    };
    const key = createHash("sha256")
      .update(JSON.stringify([target.appId, instance.instance_id, params]))
      .digest("hex");
    try {
      const created = await createAndroidApplication(
        target.appId,
        instance.instance_id,
        params,
        `android-init-${key}`,
      );
      if (!matchingRegistration([created], project))
        throw new CliError(
          "Android registration returned a different applicationId. Local setup was not applied.",
        );
    } catch (error) {
      // A concurrent creator or a lost successful response can leave the row in
      // place. Reconcile it; never overwrite or silently change a registration.
      if (
        !(error instanceof TypeError) &&
        !(error instanceof PlapiError && (error.status === 422 || error.status >= 500))
      )
        throw error;
      const current = await listAndroidApplications(target.appId, instance.instance_id);
      if (!matchingRegistration(current, project)) throw error;
    }
  }
  try {
    await applyAndroidProject(prepared);
  } catch (error) {
    log.warn(
      "Native settings/registration may already be saved. Local changes were rolled back where possible; rerun init to finish setup.",
    );
    throw error;
  }
  log.success(hasChanges ? "Android setup complete." : "Android is already set up.");
  for (const instruction of prepared.plan.postInstructions) log.info(instruction);
}
