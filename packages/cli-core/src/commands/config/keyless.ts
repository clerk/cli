/**
 * Keyless config access — reading and updating an unclaimed keyless application
 * through Clerk's Backend API, using only its instance secret key.
 *
 * The account-authenticated path (`lib/plapi.ts`) addresses one config document
 * per instance. BAPI has no such document: it exposes independent resources.
 * Rather than guess a mapping between the two shapes, the keyless payload
 * mirrors BAPI directly — one top-level key per resource — so what you write is
 * exactly what gets sent.
 *
 * Finding and addressing the application itself lives in `lib/keyless-target.ts`,
 * which the feature-toggle, whoami, and env commands share.
 */

import { bapiRequest } from "../../lib/bapi.ts";
import { ERROR_CODE, throwUsageError, withApiContext } from "../../lib/errors.ts";
import type { KeylessTarget } from "../../lib/keyless-target.ts";
import { log } from "../../lib/log.ts";

/**
 * BAPI resources reachable with an instance secret key, keyed by the name they
 * take in a keyless config payload. `readable: false` marks a resource BAPI
 * exposes for writes only (no GET route), so it never appears in a pull.
 *
 * Names follow the `object` field each endpoint returns, so what you write here
 * matches what the API calls it.
 */
const KEYLESS_GROUPS = {
  instance: { path: "/v1/instance", readable: true },
  communication: { path: "/v1/instance/communication", readable: true },
  restrictions: { path: "/v1/instance/restrictions", readable: false },
  organization_settings: { path: "/v1/instance/organization_settings", readable: true },
  protect: { path: "/v1/instance/protect", readable: true },
  oauth_application_settings: { path: "/v1/instance/oauth_application_settings", readable: true },
  // Backed by a beta route (`/v1/beta_features/instance_settings`) that updates
  // the auth config: restricted_to_allowlist, from_email_address,
  // progressive_sign_up, test_mode.
  instance_settings: { path: "/v1/beta_features/instance_settings", readable: false },
} as const;

export type KeylessGroup = keyof typeof KEYLESS_GROUPS;

export const KEYLESS_GROUP_NAMES = Object.keys(KEYLESS_GROUPS) as KeylessGroup[];

function isGroupName(name: string): name is KeylessGroup {
  return name in KEYLESS_GROUPS;
}

function isReadable(name: KeylessGroup): boolean {
  return KEYLESS_GROUPS[name].readable;
}

/**
 * Validates caller-supplied names once, at the boundary, so everything
 * downstream works with a known group instead of re-checking strings.
 */
function asGroupNames(names: string[]): KeylessGroup[] {
  const unknown = names.filter((name) => !isGroupName(name));
  if (unknown.length > 0) {
    throwUsageError(
      `Unsupported config ${unknown.length === 1 ? "key" : "keys"} for an unclaimed keyless application: ${unknown.join(", ")}.\n` +
        `Supported keys: ${KEYLESS_GROUP_NAMES.join(", ")}.`,
    );
  }
  return names.filter(isGroupName);
}

/** Rejects payload keys that don't name a BAPI resource, before anything is sent. */
export function assertKeylessPayload(
  payload: Record<string, unknown>,
): asserts payload is Record<KeylessGroup, Record<string, unknown>> {
  const unknown = Object.keys(payload).filter((key) => !(key in KEYLESS_GROUPS));
  if (unknown.length > 0) {
    throwUsageError(
      `Unsupported config ${unknown.length === 1 ? "key" : "keys"} for an unclaimed keyless application: ${unknown.join(", ")}.\n` +
        `Supported top-level keys: ${KEYLESS_GROUP_NAMES.join(", ")}.\n` +
        "Run `clerk auth login` to claim the application and use the full config document.",
    );
  }

  for (const [key, value] of Object.entries(payload)) {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throwUsageError(
        `Config key \`${key}\` must be a JSON object.`,
        undefined,
        ERROR_CODE.INVALID_JSON,
      );
    }
  }
}

/**
 * Reads every readable group into a single envelope. Write-only groups are
 * skipped — a caller that asked for one by name is told rather than left to
 * wonder where it went.
 */
export async function pullKeylessConfig(
  target: KeylessTarget,
  keys?: string[],
): Promise<Record<string, unknown>> {
  const requested = keys?.length ? asGroupNames(keys) : KEYLESS_GROUP_NAMES;

  // Only worth saying when the caller named a write-only group. A default pull
  // asks for everything, and reporting the same omission every time is noise.
  const unreadable = keys?.length ? requested.filter((name) => !isReadable(name)) : [];
  if (unreadable.length > 0) {
    log.warn(
      `Clerk's Backend API has no read route for ${unreadable.join(", ")} — omitted from the output.`,
    );
  }

  const config: Record<string, unknown> = {};
  for (const name of requested.filter(isReadable)) {
    const response = await withApiContext(
      bapiRequest({ method: "GET", path: KEYLESS_GROUPS[name].path, secretKey: target.secretKey }),
      `Failed to fetch ${name}`,
    );
    config[name] = response.body;
  }

  return config;
}

/**
 * Applies each group in the payload to its own BAPI resource and returns what
 * the API reported back. `PATCH /v1/instance` answers 204 with no body, so that
 * group is re-read to give the caller something to see.
 */
export async function patchKeylessConfig(
  target: KeylessTarget,
  payload: Record<string, Record<string, unknown>>,
): Promise<Record<string, unknown>> {
  const results: Record<string, unknown> = {};

  // Each group is its own request and the Backend API has no transaction, so a
  // failure part-way through leaves earlier groups applied. Name them in the
  // error rather than letting the user guess how far it got.
  for (const name of KEYLESS_GROUP_NAMES.filter((group) => group in payload)) {
    const group = KEYLESS_GROUPS[name];
    const applied = Object.keys(results);
    const context =
      applied.length > 0
        ? `Failed to update ${name} (already applied: ${applied.join(", ")})`
        : `Failed to update ${name}`;

    const response = await withApiContext(
      bapiRequest({
        method: "PATCH",
        path: group.path,
        secretKey: target.secretKey,
        body: JSON.stringify(payload[name]),
      }),
      context,
    );

    if (response.body) {
      results[name] = response.body;
      continue;
    }

    // A 204 carries nothing to show; re-read so the caller still sees the group.
    results[name] = group.readable
      ? (
          await withApiContext(
            bapiRequest({ method: "GET", path: group.path, secretKey: target.secretKey }),
            `Failed to fetch ${name}`,
          )
        ).body
      : null;
  }

  return results;
}

/** Current state of the groups a payload touches, for diffing before a write. */
export async function readCurrentGroups(
  target: KeylessTarget,
  payload: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const readable = Object.keys(payload).filter(isGroupName).filter(isReadable);
  return readable.length > 0 ? pullKeylessConfig(target, readable) : {};
}
