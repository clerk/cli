import {
  MIGRATE_TELEMETRY_SOURCES,
  setTelemetryMigrateSource,
  setTelemetryTarget,
  type MigrateTelemetrySource,
} from "../../lib/telemetry.ts";
import type { RunTarget } from "./lib/run-store.ts";

/**
 * Record the Clerk app and instance a migrate command acted on. A `key_`
 * stand-in or an alias never reaches the event: `setTelemetryTarget` drops
 * anything that is not an `app_`/`ins_` ID.
 */
export function recordMigrateTarget(target: Pick<RunTarget, "appId" | "instanceId">): void {
  setTelemetryTarget({ appId: target.appId, instanceId: target.instanceId });
}

/**
 * Record where the users come from. A source someone wrote is `custom`, as is
 * any key this CLI does not ship: its name is theirs, and may say more than a
 * platform does.
 */
export function recordMigrateSource(
  key: string | undefined,
  options: { custom?: boolean } = {},
): void {
  if (!key) return;
  setTelemetryMigrateSource(!options.custom && isBuiltInSource(key) ? key : "custom");
}

function isBuiltInSource(key: string): key is MigrateTelemetrySource {
  return key !== "custom" && (MIGRATE_TELEMETRY_SOURCES as readonly string[]).includes(key);
}
