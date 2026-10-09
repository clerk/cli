/**
 * Batched `GET /v1/users` lookups by a list of values.
 *
 * BAPI filters on up to 100 values per call and leaves out any it does not
 * find, so the work is proportional to the list rather than to the instance.
 * Every call goes through the run's scheduler and backs off on a 429, exactly
 * as the writes do.
 */

import { bapiRequest } from "../../../lib/bapi.ts";
import type { SpinnerControls } from "../../../lib/spinner.ts";
import { retryOn429 } from "./retry.ts";
import type { ApiScheduler } from "./scheduler.ts";

/** BAPI accepts at most 100 values per filter on `GET /v1/users`. */
export const LOOKUP_BATCH = 100;

/** The fields of a BAPI user these lookups read. */
export type LookedUpUser = {
  id: string;
  external_id?: string | null;
  username?: string | null;
  private_metadata?: Record<string, unknown> | null;
  last_sign_in_at?: number | null;
  email_addresses?: { email_address?: string }[];
  phone_numbers?: { phone_number?: string }[];
};

export type LookupFilter =
  | "user_id"
  | "external_id"
  | "email_address"
  | "phone_number"
  | "username";

/** Splits `items` into chunks of at most `size`. */
export function batch<T>(items: T[], size: number): T[][] {
  const batches: T[][] = [];
  for (let i = 0; i < items.length; i += size) batches.push(items.slice(i, i + size));
  return batches;
}

/** Every user matching any of `values` on `filter`. */
export async function lookupUsers(options: {
  filter: LookupFilter;
  values: string[];
  secretKey: string;
  schedule: ApiScheduler;
  spinner?: SpinnerControls;
  label?: string;
}): Promise<LookedUpUser[]> {
  const batches = batch([...new Set(options.values)], LOOKUP_BATCH);
  let done = 0;

  const pages = await Promise.all(
    batches.map(async (values) => {
      const params = new URLSearchParams();
      params.set("limit", String(LOOKUP_BATCH));
      // BAPI reads a leading `-` on an `external_id` as "exclude" and strips a
      // leading `+`, so an explicit `+` keeps a source ID like `-abc` literal.
      for (const value of values) {
        params.append(options.filter, options.filter === "external_id" ? `+${value}` : value);
      }

      // A 429 pauses every lookup still queued, as on import.
      const response = await retryOn429(
        async () =>
          options.schedule(async () =>
            bapiRequest({
              method: "GET",
              path: `/v1/users?${params.toString()}`,
              secretKey: options.secretKey,
            }),
          ),
        { onRetry: ({ delaySeconds }) => options.schedule.pause(delaySeconds * 1000) },
      );
      done++;
      options.spinner?.update(`${options.label ?? "Looking up users"}: ${done}/${batches.length}`);
      const users = response.body;
      return Array.isArray(users) ? (users as LookedUpUser[]) : [];
    }),
  );

  return pages.flat().filter((user) => typeof user.id === "string");
}

/**
 * The `private_metadata` key every import create carries: the ID of the run
 * that sent it. It is how a continue or an undo knows a user found by
 * `external_id` is that run's own create, and not one an app or another tool
 * made with the same source ID.
 */
export const RUN_MARKER_KEY = "clerkMigrateRun";

/**
 * The users behind creates that were in flight when run `runId` stopped:
 * found by `external_id`, and counted only when they carry the run's marker.
 * One without it stays unresolved: a continue's checks find it in the
 * instance, and `undo` leaves it alone. That includes a create from a run
 * recorded before the marker existed.
 */
export async function findInFlight(options: {
  runId: string;
  sourceIds: string[];
  secretKey: string;
  schedule: ApiScheduler;
}): Promise<{ sourceId: string; clerkId: string }[]> {
  if (options.sourceIds.length === 0) return [];
  const found = await lookupUsers({
    filter: "external_id",
    values: options.sourceIds,
    secretKey: options.secretKey,
    schedule: options.schedule,
  });
  const wanted = new Set(options.sourceIds);
  return found
    .filter(
      (user) =>
        user.external_id &&
        wanted.has(user.external_id) &&
        user.private_metadata?.[RUN_MARKER_KEY] === options.runId,
    )
    .map((user) => ({ sourceId: user.external_id as string, clerkId: user.id }));
}
