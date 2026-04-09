import type { Application } from "../../lib/plapi.ts";
import { isAgent } from "../../mode.ts";
import { log } from "../../lib/log.ts";

export type AppsOptions = {
  json?: boolean;
};

export function stripSecrets(app: Application) {
  return {
    ...app,
    instances: app.instances.map(({ secret_key: _, ...rest }) => rest),
  };
}

export const displayName = (app: Application) => app.name ?? app.application_id;

export function printJson(data: unknown, options: AppsOptions = {}): boolean {
  if (!options.json && !isAgent()) return false;
  log.data(JSON.stringify(data, null, 2));
  return true;
}
