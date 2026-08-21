import { CliError, ERROR_CODE } from "./errors.ts";
import type { Application, ApplicationInstance } from "./plapi.ts";

export const INSTANCE_ALIASES: Record<string, "development" | "production"> = {
  dev: "development",
  development: "development",
  prod: "production",
  production: "production",
};

export function resolveFetchedApplicationInstance(
  appId: string,
  app: Application,
  instance?: string,
):
  | { found: true; instance: ApplicationInstance; instanceId: string; instanceLabel: string }
  | { found: false; instanceId: string; instanceLabel: string } {
  if (instance) {
    const environment = INSTANCE_ALIASES[instance];
    if (environment) {
      const matched = app.instances.find((entry) => entry.environment_type === environment);
      if (!matched) {
        throw new CliError(`No ${environment} instance found for application ${appId}.`, {
          code: ERROR_CODE.INSTANCE_NOT_FOUND,
        });
      }
      return {
        found: true,
        instance: matched,
        instanceId: matched.instance_id,
        instanceLabel: environment,
      };
    }

    const matched = app.instances.find((entry) => entry.instance_id === instance);
    if (matched) {
      return {
        found: true,
        instance: matched,
        instanceId: matched.instance_id,
        // Downstream guardrails key off the environment label when it is available.
        instanceLabel: matched.environment_type || instance,
      };
    }

    return { found: false, instanceId: instance, instanceLabel: instance };
  }

  const development = app.instances.find((entry) => entry.environment_type === "development");
  if (!development) {
    throw new CliError(`No development instance found for application ${appId}.`, {
      code: ERROR_CODE.INSTANCE_NOT_FOUND,
    });
  }
  return {
    found: true,
    instance: development,
    instanceId: development.instance_id,
    instanceLabel: "development",
  };
}
