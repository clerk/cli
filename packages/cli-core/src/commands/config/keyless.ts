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
 * Top-level keys that aren't a config group but ARE reachable on an unclaimed
 * keyless application — BAPI resource collections with their own routes,
 * verified live (`clerk api /enterprise_connections` lists and creates them
 * with just an instance secret key). Naming these in the "claim the app"
 * advice would send someone on a detour they don't need: `clerk api` already
 * works, and claiming wouldn't add them to the config document either.
 */
const API_REACHABLE_KEYLESS_KEYS = new Set([
  "enterprise_connections",
  "saml_connections",
  "oauth_applications",
  "domains",
  "allowlist_identifiers",
  "blocklist_identifiers",
]);

/**
 * Every field `PATCH /v1/instance` accepts, from the Backend API's own schema
 * (`additionalProperties: false`).
 *
 * This is the one group whose write can't be checked against anything: it
 * answers 204 with no body, so an unrecognised field name is indistinguishable
 * from an applied one — BAPI drops what it doesn't know rather than rejecting
 * it. Naming the fields here moves that failure forward to a usage error, and
 * is worth the maintenance precisely because the alternative is silent. Sending
 * `{"instance": {"password": "on"}}` used to report success and change nothing.
 *
 * Every other group echoes its new state back, so a typo there already surfaces
 * as a dropped field and needs no list.
 */
const INSTANCE_FIELDS = new Set([
  "test_mode",
  "hibp",
  "support_email",
  "clerk_js_version",
  "development_origin",
  "allowed_origins",
  "cookieless_dev",
  "url_based_session_syncing",
  "preferred_sign_in_strategy_when_password_required",
]);

/**
 * Auth settings people reach for on the `instance` group that BAPI has no route
 * for at all, mapped to the reason. Worth naming individually: "unsupported
 * field" reads like a typo, and someone who just tried to turn on GitHub sign-in
 * deserves to know no amount of retyping will do it.
 */
const ACCOUNT_ONLY_INSTANCE_FIELDS: Record<string, string> = {
  password: "which authentication strategies are enabled",
  phone_number: "which authentication strategies are enabled",
  username: "which authentication strategies are enabled",
  email_address: "which authentication strategies are enabled",
  passkey: "which authentication strategies are enabled",
  social: "social sign-in providers",
  oauth: "social sign-in providers",
  second_factors: "multi-factor authentication policy",
  application_name: "the application's name and branding",
};

/**
 * Rejects `instance` fields BAPI would silently discard, before the request is
 * sent. Runs only for that group — see `INSTANCE_FIELDS`.
 */
function assertInstanceFields(fields: Record<string, unknown>): void {
  const unknown = Object.keys(fields).filter((field) => !INSTANCE_FIELDS.has(field));
  if (unknown.length === 0) return;

  const lines = [
    `Unsupported ${unknown.length === 1 ? "field" : "fields"} on \`instance\` for an unclaimed keyless application: ${unknown.join(", ")}.`,
    `Supported fields: ${[...INSTANCE_FIELDS].join(", ")}.`,
  ];

  // Say why, once per distinct reason, for the fields people actually try.
  const reasons = [
    ...new Set(unknown.map((field) => ACCOUNT_ONLY_INSTANCE_FIELDS[field]).filter(Boolean)),
  ];
  for (const reason of reasons) {
    lines.push(
      `Clerk's Backend API has no route for ${reason}, so this can't be changed from an unclaimed application at all — claim it first with \`clerk auth login\`.`,
    );
  }

  throwUsageError(lines.join("\n"));
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
    const apiReachable = unknown.filter((key) => API_REACHABLE_KEYLESS_KEYS.has(key));
    const accountOnly = unknown.filter((key) => !API_REACHABLE_KEYLESS_KEYS.has(key));

    const lines = [
      `Unsupported config ${unknown.length === 1 ? "key" : "keys"} for an unclaimed keyless application: ${unknown.join(", ")}.`,
      `Supported top-level keys: ${KEYLESS_GROUP_NAMES.join(", ")}.`,
    ];

    // Point these at `clerk api` — they're reachable today, and claiming the
    // application wouldn't move them into the config document anyway.
    if (apiReachable.length > 0) {
      lines.push(
        `${apiReachable.join(", ")} ${apiReachable.length === 1 ? "is" : "are"} already reachable on an unclaimed application — use \`clerk api /${apiReachable[0]}\` directly instead of this config document.`,
      );
    }

    // Everything left really is part of the account-mode config document.
    if (accountOnly.length > 0) {
      lines.push(
        "Run `clerk auth login` to claim the application and use the full config document.",
      );
    }

    throwUsageError(lines.join("\n"));
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

  if (payload.instance) {
    assertInstanceFields(payload.instance as Record<string, unknown>);
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

export interface KeylessWriteVerification {
  /** Dotted `group.field` paths confirmed to hold the value that was sent. */
  verifiedFields: string[];
  /**
   * Dotted `group.field` paths the API's own response to the write doesn't
   * reflect — a 200 there means "request accepted", not "field applied", and
   * BAPI silently drops fields it doesn't recognize instead of rejecting them.
   */
  droppedFields: string[];
  /** Groups whose write answered with no body, so it can't be confirmed either way. */
  unverifiableGroups: KeylessGroup[];
}

export interface KeylessPatchResult {
  /** Per-group state as reported back by the API — same envelope shape a pull returns. */
  applied: Record<string, unknown>;
  verification: KeylessWriteVerification;
}

/**
 * Walks every leaf the caller sent and records whether the observed value
 * (the API's own read-back) matches it. `sent` is always an object — payload
 * groups are validated by `assertKeylessPayload` before this runs — so only
 * `observed` needs a runtime check; a group BAPI dropped won't have it.
 */
function collectVerifiedLeaves(
  sent: Record<string, unknown>,
  observed: unknown,
  path: string,
  out: { path: string; matched: boolean }[],
): void {
  const observedObj =
    observed !== null && typeof observed === "object" && !Array.isArray(observed)
      ? (observed as Record<string, unknown>)
      : undefined;

  for (const [key, value] of Object.entries(sent)) {
    const fieldPath = path ? `${path}.${key}` : key;
    const observedValue = observedObj?.[key];

    if (value !== null && typeof value === "object" && !Array.isArray(value)) {
      collectVerifiedLeaves(value as Record<string, unknown>, observedValue, fieldPath, out);
      continue;
    }

    out.push({ path: fieldPath, matched: JSON.stringify(value) === JSON.stringify(observedValue) });
  }
}

/**
 * Applies each group in the payload to its own BAPI resource and returns what
 * the API reported back, plus which of the sent fields that report actually
 * confirms landed.
 *
 * Verification uses the PATCH response body and nothing else. A follow-up GET
 * looks like better evidence and isn't: BAPI omits writable-but-not-readable
 * fields from its reads (`instance.support_email` is never echoed), and reads
 * are eventually consistent, so a GET issued straight after a write can still
 * be showing the old value. Either would report a perfectly good write as
 * dropped.
 *
 * `PATCH /v1/instance` answers 204 with no body at all, and that group is
 * reported with no state rather than re-read. An earlier version did re-read it
 * "so the caller sees something", which turned out to be the worst of both: the
 * eventually-consistent GET routinely returned the pre-write value, and printing
 * it directly under `Config pushed successfully` read as though the write had
 * been ignored. Nothing is more honest than a stale something here — the fields
 * that group accepts are validated before the request goes out, so a 204 is
 * already good evidence the write landed.
 */
export async function patchKeylessConfig(
  target: KeylessTarget,
  payload: Record<string, Record<string, unknown>>,
): Promise<KeylessPatchResult> {
  const results: Record<string, unknown> = {};
  const verifiedFields: string[] = [];
  const droppedFields: string[] = [];
  const unverifiableGroups: KeylessGroup[] = [];
  // Tracked separately from `results`, which only carries groups that returned
  // state to show. A group can be applied and still contribute nothing to the
  // envelope, and a later failure has to name it regardless.
  const appliedGroups: KeylessGroup[] = [];

  // Each group is its own request and the Backend API has no transaction, so a
  // failure part-way through leaves earlier groups applied. Name them in the
  // error rather than letting the user guess how far it got.
  for (const name of KEYLESS_GROUP_NAMES.filter((group) => group in payload)) {
    const group = KEYLESS_GROUPS[name];
    const context =
      appliedGroups.length > 0
        ? `Failed to update ${name} (already applied: ${appliedGroups.join(", ")})`
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

    const written = response.body ?? null;
    appliedGroups.push(name);

    if (!written) {
      // Nothing came back to check against, and nothing worth inventing: see
      // the note above on why the re-read that used to live here was removed.
      // The group is left out of the envelope entirely rather than shown as
      // null, and the success line names it as unconfirmed.
      unverifiableGroups.push(name);
      continue;
    }

    results[name] = written;

    const leaves: { path: string; matched: boolean }[] = [];
    collectVerifiedLeaves(payload[name] ?? {}, written, "", leaves);
    for (const leaf of leaves) {
      (leaf.matched ? verifiedFields : droppedFields).push(`${name}.${leaf.path}`);
    }
  }

  return { applied: results, verification: { verifiedFields, droppedFields, unverifiableGroups } };
}

/** Current state of the groups a payload touches, for diffing before a write. */
export async function readCurrentGroups(
  target: KeylessTarget,
  payload: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const readable = Object.keys(payload).filter(isGroupName).filter(isReadable);
  return readable.length > 0 ? pullKeylessConfig(target, readable) : {};
}
