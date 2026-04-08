import type { Application } from "../../lib/plapi.ts";

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
