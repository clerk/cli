import { keylessCopy } from "../../lib/copy.ts";
import { CliError, ERROR_CODE, withApiContext } from "../../lib/errors.ts";
import { resolveInstanceTarget, type InstanceTarget } from "../../lib/keyless-target.ts";
import { fetchApplication, fetchInstanceConfig } from "../../lib/plapi.ts";
import { withSpinner } from "../../lib/spinner.ts";
import { buildReport } from "./evaluate.ts";
import type { AuditReport, CheckInput, InstanceRef } from "./types.ts";

export interface LoadedAudit {
  target: Extract<InstanceTarget, { kind: "account" }>;
  input: CheckInput;
  report: AuditReport;
}

async function resolveEnvironmentType(appId: string, instanceId: string, label: string) {
  if (label === "development" || label === "production") return label;
  const app = await fetchApplication(appId);
  return app.instances.find((i) => i.instance_id === instanceId)?.environment_type ?? "unknown";
}

export async function loadAudit(options: {
  app?: string;
  instance?: string;
}): Promise<LoadedAudit> {
  const target = await resolveInstanceTarget(options);
  if (target.kind === "keyless") {
    throw new CliError(keylessCopy.securityNeedsClaimedApplication(), {
      code: ERROR_CODE.AUTH_REQUIRED,
    });
  }

  const { appId, instanceId, instanceLabel } = target.ctx;
  const { config, environmentType } = await withSpinner(
    `Fetching config from ${target.label}...`,
    async () => {
      const [config, environmentType] = await Promise.all([
        withApiContext(fetchInstanceConfig(appId, instanceId), "Failed to fetch config"),
        withApiContext(
          resolveEnvironmentType(appId, instanceId, instanceLabel),
          "Failed to fetch application",
        ),
      ]);
      return { config, environmentType };
    },
  );

  const ref: InstanceRef = { appId, instanceId, environmentType, label: target.label };
  const input: CheckInput = { config, environmentType };
  return { target, input, report: buildReport(input, ref) };
}
