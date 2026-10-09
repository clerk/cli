/**
 * Batched `GET /v1/users` lookups by a list of values.
 *
 * BAPI filters on up to 100 values per call and leaves out any it does not
 * find, so the work is proportional to the list rather than to the instance.
 * Every call goes through the run's scheduler and backs off on a 429, exactly
 * as the writes do.
 */

import fs from "node:fs";
import path from "node:path";
import { bapiRequest } from "../../../lib/bapi.ts";
import type { SpinnerControls } from "../../../lib/spinner.ts";
import { retryOn429 } from "./retry.ts";
import { clerkIdsCreatedByOtherRuns, readRun, runDir } from "./run-store.ts";
import type { ApiScheduler } from "./scheduler.ts";

/** BAPI accepts at most 100 values per filter on `GET /v1/users`. */
export const LOOKUP_BATCH = 100;

/** The fields of a BAPI user these lookups read. */
export type LookedUpUser = {
  id: string;
  external_id?: string | null;
  username?: string | null;
  /** Milliseconds since the epoch, Clerk's clock. */
  created_at?: number;
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

      const response = await retryOn429(async () =>
        options.schedule(async () =>
          bapiRequest({
            method: "GET",
            path: `/v1/users?${params.toString()}`,
            secretKey: options.secretKey,
          }),
        ),
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
 * How far a Clerk `created_at` may fall outside a run's own times and still
 * be the run's: Clerk's clock and this machine's differ.
 */
const CLOCK_SKEW_MS = 5 * 60_000;

/**
 * When run `runId` could have created users: from its start to its last
 * record write, widened by {@link CLOCK_SKEW_MS}. `undefined` when either
 * time cannot be read.
 */
function createWindow(runsDir: string, runId: string): { from: number; to: number } | undefined {
  const from = Date.parse(readRun(runsDir, runId)?.startedAt ?? "");
  let to: number;
  try {
    to = fs.statSync(path.join(runDir(runsDir, runId), "users.ndjson")).mtimeMs;
  } catch {
    return undefined;
  }
  if (!Number.isFinite(from)) return undefined;
  return { from: from - CLOCK_SKEW_MS, to: to + CLOCK_SKEW_MS };
}

/**
 * The users behind creates that were in flight when run `runId` stopped.
 *
 * Found by `external_id`, which the import's checks refused to reuse, but a
 * later run of the same source IDs can still have created one after this run
 * stopped. So any Clerk ID another import run records as created is left out,
 * and so is a user Clerk created outside this run's time: an app or another
 * tool can set the same `external_id`. One left out stays unresolved: a
 * continue's checks find it in the instance, and `undo` leaves it alone.
 *
 * ponytail: a time window, not proof. A user someone else created with the
 * same source ID while the run was going still reads as the run's; a marker
 * on each create would prove it, at the cost of writing one into every user.
 */
export async function findInFlight(options: {
  runsDir: string;
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
  const otherRuns = clerkIdsCreatedByOtherRuns(options.runsDir, options.runId);
  const window = createWindow(options.runsDir, options.runId);
  if (!window) return [];
  const wanted = new Set(options.sourceIds);
  const inWindow = (createdAt: number | undefined) =>
    typeof createdAt === "number" && createdAt >= window.from && createdAt <= window.to;
  return found
    .filter(
      (user) =>
        user.external_id &&
        wanted.has(user.external_id) &&
        !otherRuns.has(user.id) &&
        inWindow(user.created_at),
    )
    .map((user) => ({ sourceId: user.external_id as string, clerkId: user.id }));
}
