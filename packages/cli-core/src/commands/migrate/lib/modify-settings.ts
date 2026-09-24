/**
 * Turning a flagged Migration Readiness row into the instance-config change
 * that would stop it being flagged.
 *
 * The report already knows which settings will cost users; without this the
 * only way to act on it is to leave the CLI, find the setting in the dashboard,
 * and come back. Each change is a single leaf in the Platform API's config
 * document, so they compose into one `PATCH` however many the operator picks.
 *
 * These are offers, not corrections. A flagged setting is not a wrong setting —
 * an instance that genuinely requires an email address is configured exactly as
 * its owner intended, and the right answer may well be to fix the export
 * instead. Nothing here is preselected and nothing is applied unasked.
 *
 * Only the two verdicts `buildReadinessReport` produces are mapped: "required
 * in Clerk" (relax the requirement) and "not enabled in Clerk" (turn it on). A
 * row this file has no path for is simply not offered — the report still names
 * it and still points at the dashboard.
 */

import type { UserSettingsJSON } from "../../../lib/fapi.ts";
import { toClerkStrategy } from "./clerk-config.ts";
import type { ReadinessItem, ReadinessSection } from "./readiness.ts";

/** One leaf of the config document, and what to set it to. */
export type SettingWrite = { path: string[]; value: boolean | string[] };

/** One offered change: what it says, and the config leaves it writes. */
export type SettingChange = {
  /** Stable identity for the multiselect, and for tests. */
  id: string;
  label: string;
  section: ReadinessSection;
  /** `enable` turns something on; `relax` drops a requirement. */
  kind: "enable" | "relax";
  writes: SettingWrite[];
};

type ChangeWrites = { enable: SettingWrite[]; relax: SettingWrite[] };

/**
 * Where each attribute lives in the config document. `used_for_sign_up` is the
 * enable field that matters here: `POST /v1/users` validates an import against
 * the instance's sign-up requirements, not its sign-in strategies.
 *
 * Email and phone are **verifiable** attributes, so enabling one takes two
 * writes rather than one. Clerk rejects a verifiable attribute that is on with
 * no way to verify it — `422 phone_number: verifiable attributes need to have
 * at least one verification` — and switching the attribute off empties
 * `verification_strategies`, so whatever turns it back on has to put a strategy
 * back. Username, password and the name fields are not verifiable and take one
 * write each.
 */
const ATTRIBUTE_WRITES: Record<string, ChangeWrites> = {
  email_address: {
    enable: [
      { path: ["auth_email", "used_for_sign_up"], value: true },
      { path: ["auth_email", "verification_strategies"], value: ["email_code"] },
    ],
    relax: [{ path: ["auth_email", "required_for_sign_up"], value: false }],
  },
  phone_number: {
    enable: [
      { path: ["auth_phone", "used_for_sign_up"], value: true },
      { path: ["auth_phone", "verification_strategies"], value: ["phone_code"] },
    ],
    relax: [{ path: ["auth_phone", "required_for_sign_up"], value: false }],
  },
  username: {
    enable: [{ path: ["auth_username", "used_for_sign_up"], value: true }],
    relax: [{ path: ["auth_username", "required_for_sign_up"], value: false }],
  },
  password: {
    enable: [{ path: ["auth_password", "enabled"], value: true }],
    relax: [{ path: ["auth_password", "required"], value: false }],
  },
  first_name: {
    enable: [{ path: ["user_model", "first_name", "enabled"], value: true }],
    relax: [{ path: ["user_model", "first_name", "required"], value: false }],
  },
  last_name: {
    enable: [{ path: ["user_model", "last_name", "enabled"], value: true }],
    relax: [{ path: ["user_model", "last_name", "required"], value: false }],
  },
};

/** `github` → `connection_oauth_github`, via Clerk's own strategy name. */
function socialPath(provider: string): string[] {
  return [`connection_oauth_${toClerkStrategy(provider).replace(/^oauth_/, "")}`, "enabled"];
}

function changeFor(item: ReadinessItem): SettingChange | undefined {
  // Required-but-not-universal is the only verdict that relaxes rather than
  // enables; every other flagged row is something switched off in Clerk.
  const relax = item.clerkRequired === true;

  if (item.section === "social") {
    // A provider has no "required" in Clerk, so there is nothing to relax.
    if (relax) return undefined;
    return {
      id: item.key,
      label: `Enable ${item.label} sign-in`,
      section: item.section,
      kind: "enable",
      writes: [{ path: socialPath(item.key), value: true }],
    };
  }

  const writes = ATTRIBUTE_WRITES[item.key];
  if (!writes) return undefined;

  return {
    id: item.key,
    label: relax ? `Make ${item.label} optional at sign-up` : `Enable ${item.label}`,
    section: item.section,
    kind: relax ? "relax" : "enable",
    writes: relax ? writes.relax : writes.enable,
  };
}

/** The changes offerable for a report's flagged rows, in report order. */
export function buildSettingChanges(flagged: ReadinessItem[]): SettingChange[] {
  return flagged.map(changeFor).filter((change): change is SettingChange => change !== undefined);
}

/**
 * Collapses the chosen changes into one config payload.
 *
 * Changes share parents — `first_name` and `last_name` both write `user_model`
 * — so leaves are written into a shared tree rather than merged after the fact.
 */
export function buildChangePayload(changes: SettingChange[]): Record<string, unknown> {
  const payload: Record<string, unknown> = {};

  for (const write of changes.flatMap((change) => change.writes)) {
    let node = payload;
    for (const key of write.path.slice(0, -1)) {
      node = (node[key] ??= {}) as Record<string, unknown>;
    }
    node[write.path[write.path.length - 1] as string] = write.value;
  }

  return payload;
}

/**
 * The instance's settings as they stand once `changes` have been written.
 *
 * Deliberately not a re-read. Clerk's Frontend API is eventually consistent, so
 * a `/v1/environment` fetch issued straight after the config write routinely
 * still reports the pre-write settings — which would redraw the report with
 * every row it just cleared still flagged. The Platform API answering the write
 * is the authoritative statement of what took, exactly as `clerk config patch`
 * treats it.
 *
 * @param settings - `null` passes through: when the settings could not be read
 *   nothing is ever flagged, so there is nothing to have changed.
 */
export function applyChanges(
  settings: UserSettingsJSON | null,
  changes: SettingChange[],
): UserSettingsJSON | null {
  if (!settings) return null;

  const next = structuredClone(settings);

  for (const change of changes) {
    if (change.section === "social") {
      const social = next.social as Record<string, { enabled: boolean }>;
      const strategy = toClerkStrategy(change.id);
      social[strategy] = { ...social[strategy], enabled: true };
      continue;
    }

    const attributes = next.attributes as Record<string, { enabled: boolean; required: boolean }>;
    attributes[change.id] =
      change.kind === "enable"
        ? {
            ...attributes[change.id],
            enabled: true,
            required: attributes[change.id]?.required ?? false,
          }
        : {
            ...attributes[change.id],
            enabled: attributes[change.id]?.enabled ?? true,
            required: false,
          };
  }

  return next;
}
